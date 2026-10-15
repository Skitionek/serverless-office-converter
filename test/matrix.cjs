#!/usr/bin/env node
/* Compatibility matrix: converts every input fixture to every output format the
 * converter offers for it, in headless Chromium, and saves the results.
 *
 *   node test/matrix.cjs --make-fixtures   # (re)generate test/fixtures/matrix/ with the engine
 *   node test/matrix.cjs [--out test/out/matrix] [--only docx,xlsx]
 *   python3 test/matrix-report.py          # validate the outputs, update the README table
 *
 * Needs playwright (npm install --no-save playwright, or NODE_PATH to a global install).
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(process.env.WEB_ROOT || path.join(__dirname, '..', 'web'));
const FIXTURES = path.join(__dirname, 'fixtures');
const MATRIX = path.join(FIXTURES, 'matrix');
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const OUT = path.resolve(arg('--out', path.join(__dirname, 'out', 'matrix')));
const PREFIX = '/serverless-office-converter/';

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
};

function serve() {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        if (!url.pathname.startsWith(PREFIX)) return res.writeHead(404).end();
        let rel = decodeURIComponent(url.pathname.slice(PREFIX.length)) || 'index.html';
        if (rel.endsWith('/')) rel += 'index.html';
        const file = path.join(ROOT, rel);
        if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            return res.writeHead(404).end('not found');
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function openPage(ctx) {
    const page = await ctx.browser.newPage();
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    await page.goto(`http://127.0.0.1:${ctx.server.address().port}${PREFIX}`);
    await page.waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 30000 });
    await page.evaluate(() => window.officeConverter.engine.start());
    ctx.page = page;
}

async function open() {
    const ctx = { server: await serve(), browser: await chromium.launch(), page: null };
    await openPage(ctx);
    return { ...ctx, ctx, page: ctx.page };
}

// Converts one file in the page; resolves to {ok, b64?, error?, family?}.
function convertInPage(page, name, buffer, targetId) {
    return page.evaluate(async ({ name, b64, targetId }) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        try {
            const r = await window.officeConverter.engine.convertFile(new File([bytes], name), targetId);
            const buf = new Uint8Array(await r.blob.arrayBuffer());
            let s = '';
            for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
            return { ok: true, b64: btoa(s), family: r.family };
        } catch (e) {
            return { ok: false, error: String(e.message || e), family: e.family };
        }
    }, { name, b64: buffer.toString('base64'), targetId });
}

// --- fixtures ---------------------------------------------------------------

const TEXT = 'Serverless Office Converter';
const FIXTURE_PLAN = [
    // [extension, how it is made, marker text that must survive conversion]
    ['docx', { copy: 'sample.docx' }, TEXT],
    ['doc', { from: 'docx', to: 'doc' }, TEXT],
    ['odt', { from: 'docx', to: 'odt' }, TEXT],
    ['fodt', { from: 'docx', to: 'fodt' }, TEXT],
    ['rtf', { from: 'docx', to: 'rtf' }, TEXT],
    ['txt', { text: TEXT + ' converts documents in the browser.\nSecond line: Zażółć gęślą jaźń.\n' }, TEXT],
    ['md', { text: '# ' + TEXT + '\n\nSome *emphasis* and **strong** text.\n\n- one\n- two\n' }, TEXT],
    ['html', { text: '<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body><h1>' + TEXT + '</h1><p>Paragraph with <b>bold</b> text.</p><ul><li>a</li><li>b</li></ul></body></html>\n' }, TEXT],
    ['xlsx', { copy: 'sample.xlsx' }, 'North'],
    ['xls', { from: 'xlsx', to: 'xls' }, 'North'],
    ['ods', { from: 'xlsx', to: 'ods' }, 'North'],
    ['fods', { from: 'xlsx', to: 'fods' }, 'North'],
    ['csv', { text: 'Region,Q1,Q2,Total\nNorth,200,300,500\nSouth,300,450,750\n' }, 'North'],
    ['tsv', { text: 'Region\tQ1\tQ2\tTotal\nNorth\t200\t300\t500\nSouth\t300\t450\t750\n' }, 'North'],
    ['pptx', { copy: 'sample.pptx' }, TEXT],
    ['ppt', { from: 'pptx', to: 'ppt' }, TEXT],
    ['odp', { from: 'pptx', to: 'odp' }, TEXT],
    ['fodp', { from: 'pptx', to: 'fodp' }, TEXT],
    ['svg', { copy: 'sample.svg' }, null],
    ['odg', { from: 'svg', to: 'odg' }, null],
    ['png', { from: 'docx', to: 'png' }, null],
    ['jpg', { from: 'docx', to: 'jpg' }, null],
];

async function makeFixtures() {
    fs.mkdirSync(MATRIX, { recursive: true });
    const { server, browser, page } = await open();
    const manifest = [];
    try {
        for (const [ext, how, marker] of FIXTURE_PLAN) {
            const file = path.join(MATRIX, `sample.${ext}`);
            if (how.copy) {
                fs.copyFileSync(path.join(FIXTURES, how.copy), file);
            } else if (how.text !== undefined) {
                fs.writeFileSync(file, how.text);
            } else {
                const src = path.join(MATRIX, `sample.${how.from}`);
                const r = await convertInPage(page, `sample.${how.from}`, fs.readFileSync(src), how.to);
                if (!r.ok) throw new Error(`could not make ${ext} from ${how.from}: ${r.error}`);
                fs.writeFileSync(file, Buffer.from(r.b64, 'base64'));
            }
            manifest.push({ ext, marker, source: how.copy ? 'python-docx/openpyxl/python-pptx or hand-written' : how.text !== undefined ? 'hand-written' : `converted from sample.${how.from} by this converter` });
            console.log('fixture', ext, fs.statSync(file).size, 'bytes');
        }
    } finally {
        await browser.close();
        server.close();
    }
    fs.writeFileSync(path.join(MATRIX, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

// --- matrix -----------------------------------------------------------------

// Tries a combination the converter does not offer, by applying the target's own export
// filter to whatever kind of document the input turned into.
async function tryCross(ctx, row, name, buffer, target) {
    const started = Date.now();
    const run = ctx.page.evaluate(async ({ name, b64, targetId }) => {
        const m = await import('./office-converter/formats.js');
        window.officeConverter.engine.timeoutMs = 25000; // forced filters can hang: count that as failing
        const t = m.TARGET_BY_ID.get(targetId);
        const filter = Object.values(t.filters)[0];
        const filters = Object.fromEntries(['writer', 'web', 'calc', 'impress', 'draw', 'math'].map((k) => [k, filter]));
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const ext = name.slice(name.lastIndexOf('.') + 1);
        try {
            const out = await window.officeConverter.engine.convert(
                bytes.buffer, name, { ...t, filters }, m.INPUT_FILTERS[ext]);
            const buf = new Uint8Array(out.data);
            let s = '';
            for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
            return { ok: true, b64: btoa(s), family: out.family };
        } catch (e) {
            return { ok: false, error: String(e.message || e) };
        }
    }, { name, b64: buffer.toString('base64'), targetId: target.id });
    let r;
    try {
        r = await Promise.race([run, new Promise((_, rej) => setTimeout(() => rej(new Error('hung')), 90000))]);
    } catch (e) {
        // The forced filter ran the page out of memory (tab crash) or hung: start over with a new tab.
        r = { ok: false, error: /crash/i.test(e.message) ? 'tab crashed (out of memory)' : 'hung', crash: true };
        await ctx.page.close().catch(() => {});
        await openPage(ctx);
    }
    const dir = path.join(OUT, 'cross');
    fs.mkdirSync(dir, { recursive: true });
    const file = `cross/${row.ext}__${target.id}.${target.ext}`;
    if (r.ok) fs.writeFileSync(path.join(OUT, file), Buffer.from(r.b64, 'base64'));
    row.cells[target.id] = r.ok ? { status: 'n/a', cross: 'converted', file, ms: Date.now() - started }
                                : { status: 'n/a', cross: r.crash ? 'crash' : 'error', error: r.error, ms: Date.now() - started };
    console.log(`cross ${r.ok ? 'ok  ' : 'fail'} ${row.ext.padEnd(5)} -> ${target.id.padEnd(5)} ${r.ok ? '' : r.error}`);
}

async function runMatrix() {
    const manifest = JSON.parse(fs.readFileSync(path.join(MATRIX, 'manifest.json'), 'utf8'));
    const only = arg('--only') ? arg('--only').split(',') : null;
    fs.mkdirSync(OUT, { recursive: true });
    const { server, browser, ctx } = await open();
    const formats = await ctx.page.evaluate(async () => {
        const m = await import('./office-converter/formats.js');
        return { targets: m.TARGETS.map((t) => ({ id: t.id, ext: t.ext })), };
    });
    const results = { targets: formats.targets, inputs: [] };
    try {
        for (const { ext, marker } of manifest) {
            if (only && !only.includes(ext)) continue;
            const name = `sample.${ext}`;
            const buffer = fs.readFileSync(path.join(MATRIX, name));
            const offered = await ctx.page.evaluate(async (name) => {
                const m = await import('./office-converter/formats.js');
                const family = m.guessFamily(name);
                return { family, targets: m.targetsForFamily(family).map((t) => t.id) };
            }, name);
            const row = { ext, marker, family: offered.family, cells: {} };
            for (const target of formats.targets) {
                if (!offered.targets.includes(target.id)) {
                    row.cells[target.id] = { status: 'n/a' };
                    if (argv.includes('--cross')) await tryCross(ctx, row, name, buffer, target);
                    continue;
                }
                const started = Date.now();
                const r = await convertInPage(ctx.page, name, buffer, target.id);
                const file = `${ext}__${target.id}.${target.ext}`;
                if (r.ok) fs.writeFileSync(path.join(OUT, file), Buffer.from(r.b64, 'base64'));
                row.cells[target.id] = r.ok ? { status: 'converted', file, ms: Date.now() - started }
                                            : { status: 'error', error: r.error, ms: Date.now() - started };
                console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${ext.padEnd(5)} -> ${target.id.padEnd(5)} ${r.ok ? '' : r.error}`);
            }
            results.inputs.push(row);
        }
    } finally {
        await browser.close();
        server.close();
    }
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2) + '\n');
}

(argv.includes('--make-fixtures') ? makeFixtures() : runMatrix()).catch((e) => {
    console.error(e);
    process.exit(2);
});

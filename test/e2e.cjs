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
        // The Convert button of a single row converts just that file.
        const first = conv.items[0];
        first.row.querySelector('.file-convert').click();
        while (first.status !== 'done' && first.status !== 'error') await new Promise((r) => setTimeout(r, 100));
        if (conv.items[1].status !== 'queued') throw new Error('row button converted other files');
        if (!first.row.querySelector('.file-convert').hidden) throw new Error('row button still shown after converting');
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

    // A WebAssembly fault in the engine must not break the converter: the worker is replaced
    // and the job retried.
    const recovery = await page.evaluate(async () => {
        const engine = window.officeConverter.engine;
        const before = engine.worker;
        const real = engine.runJob.bind(engine);
        let calls = 0;
        engine.runJob = async (job) => {
            if (calls++ === 0) throw new Error('Could not open the document (table index is out of bounds)');
            return real(job);
        };
        const file = window.officeConverter.items[0].file;
        const r = await engine.convertFile(file, 'pdf', { priority: 5 });
        engine.runJob = real;
        return { ok: r.blob.size > 1000, calls, restarted: engine.worker !== before };
    });
    console.log(`${recovery.ok && recovery.calls === 2 && recovery.restarted ? 'PASS' : 'FAIL'}  engine fault recovery ${JSON.stringify(recovery)}`);
    if (!(recovery.ok && recovery.calls === 2 && recovery.restarted)) failed++;

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

    // File System Access: folders keep their structure, results are written as new files and
    // the originals are never replaced.  The origin private file system stands in for the
    // user's folders (its handles are the same kind of objects the pickers return).
    const fsResult = await page.evaluate(async (docxB64) => {
        const fsm = await import(new URL('office-converter/file-system.js', location.href).href);
        const conv = window.officeConverter;
        const docx = Uint8Array.from(atob(docxB64), (ch) => ch.charCodeAt(0));
        const opfs = await navigator.storage.getDirectory();
        for await (const name of opfs.keys()) await opfs.removeEntry(name, { recursive: true });
        const docs = await opfs.getDirectoryHandle('Docs', { create: true });
        const sub = await docs.getDirectoryHandle('sub', { create: true });
        for (const dir of [docs, sub]) {
            const w = await (await dir.getFileHandle('report.docx', { create: true })).createWritable();
            await w.write(docx);
            await w.close();
            await (await dir.getFileHandle('.hidden.docx', { create: true })).createWritable().then((x) => x.close());
        }
        async function tree(dir, prefix = '') {
            const out = {};
            for await (const h of dir.values()) {
                if (h.kind === 'file') out[prefix + h.name] = (await h.getFile()).size;
                else Object.assign(out, await tree(h, prefix + h.name + '/'));
            }
            return out;
        }
        async function run(entries, targets) {
            conv.addFiles(entries);
            conv.items.forEach((item, i) => { item.row.querySelector('.file-target').value = targets[i]; });
            await conv.runQueue();
            return conv.items.map((i) => i.savedTo || i.row.querySelector('.file-status').textContent);
        }
        document.getElementById('clear').click();
        const entries = await fsm.listDirectory(docs);
        const paths = entries.map((e) => e.path);
        // Saving into the folder the files came from: results go next to the originals.
        await conv.setOutputDirectory(docs);
        const first = await run(entries, ['docx', 'pdf']);
        document.getElementById('clear').click();
        const second = await run(entries.slice(1), ['pdf']);
        document.getElementById('clear').click();
        // A dropped folder's files have no handle: the original is recognised in the folder.
        const dropped = await run([{ file: entries[1].file, path: 'Docs/sub/report.docx' }], ['pdf']);
        document.getElementById('clear').click();
        // Saving somewhere else keeps the dropped folder's name and structure.
        await conv.setOutputDirectory(await opfs.getDirectoryHandle('Out', { create: true }));
        const third = await run(entries.slice(1), ['pdf']);
        await conv.setOutputDirectory(null);
        document.getElementById('clear').click();
        // Concurrent writes of the same name never collide.
        const scratch = await opfs.getDirectoryHandle('scratch', { create: true });
        const names = (await Promise.all([1, 2, 3].map((n) => fsm.writeNewFile(scratch, 'a/x.txt', 'v' + n))))
            .map((r) => r.path);
        // Picking an original in the save dialog (which empties it) puts it back and refuses.
        const original = await docs.getFileHandle('report.docx');
        const protect = [{ handle: original, data: (await original.getFile()).arrayBuffer() }];
        const realPicker = window.showSaveFilePicker;
        window.showSaveFilePicker = async () => {
            await (await original.createWritable()).close(); // what the browser does
            return docs.getFileHandle('report.docx');
        };
        let refused = null;
        try {
            await fsm.saveFileAs(new Blob(['x']), 'report.docx', { protect });
        } catch (e) {
            refused = e.name + (e.restored ? ' restored' : '');
        }
        window.showSaveFilePicker = realPicker;
        document.getElementById('clear').click();

        // Handles survive in IndexedDB; resolve() finds files inside a folder.
        await fsm.rememberHandle('test', sub);
        const recalled = await (await fsm.recallHandle('test')).isSameEntry(sub);
        await fsm.rememberHandle('test', null);
        const resolved = await fsm.relativePath(docs, await sub.getFileHandle('report.docx'));

        // Watching a folder that is also the output folder: new and changed files are converted
        // and saved next to them, and the results themselves are not picked up again.
        const until = async (fn, ms = 60000) => {
            const end = Date.now() + ms;
            while (!fn()) {
                if (Date.now() > end) throw new Error('timed out: ' + fn);
                await new Promise((r) => setTimeout(r, 100));
            }
        };
        const target = document.getElementById('all-target');
        target.value = 'docx';
        target.dispatchEvent(new Event('change'));
        await conv.addEntries(fsm.listDirectory(docs));
        const listedBefore = conv.items.map((i) => i.path);
        await conv.setOutputDirectory(docs);
        await conv.startWatching(docs);
        const watch = conv.watches.find((w) => w.dir === docs);
        const observed = watch.watcher.observed;
        const writeFile = async (dir, name) => {
            const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
            await w.write(docx);
            await w.close();
        };
        await writeFile(sub, 'new.docx');
        const isNew = (i) => i.path === 'Docs/sub/new.docx';
        await until(() => conv.items.some((i) => isNew(i) && i.savedTo));
        const newSaved = conv.items.find(isNew).savedTo;
        await writeFile(docs, 'report.docx'); // same content, new modification time
        const report = conv.items.find((i) => i.path === 'Docs/report.docx');
        await until(() => report.savedTo && report.savedTo !== null && report.status === 'done' && report.savedTo.includes('(1)'));
        const changedSaved = report.savedTo;
        await new Promise((r) => setTimeout(r, 4000)); // the results' own events
        const watchedPaths = conv.items.map((i) => i.path).filter((p) => !listedBefore.includes(p));
        watch.row.querySelector('.watch-stop').click();
        const watchStopped = !conv.watches.length;
        await conv.setOutputDirectory(null);
        document.getElementById('clear').click();
        target.value = 'pdf';
        target.dispatchEvent(new Event('change'));

        // Without FileSystemObserver, watching polls.
        let polled = null;
        const poller = await fsm.watchDirectory(sub, (e) => { polled = e.map((x) => x.path); },
            { observe: false, pollMs: 200, debounceMs: 50 });
        await writeFile(sub, 'polled.docx');
        await until(() => polled, 10000);
        poller.stop();

        // Folder access starts with an explanation; the browser's picker only opens on Continue.
        const pickerCalls = [];
        const realDirPicker = window.showDirectoryPicker;
        const picked = await opfs.getDirectoryHandle('Picked', { create: true });
        await writeFile(picked, 'a.docx');
        window.showDirectoryPicker = async (opts) => { pickerCalls.push(opts.mode); return picked; };
        const dialog = document.getElementById('fs-dialog');
        const press = async (value) => {
            dialog.querySelector(`button[value="${value}"]`).click();
            await new Promise((r) => setTimeout(r, 300));
        };
        document.getElementById('save-folder').click();
        const explainedFirst = dialog.open && pickerCalls.length === 0;
        await press('cancel');
        const cancelled = !dialog.open && pickerCalls.length === 0 && document.getElementById('out-dir').hidden;
        document.getElementById('save-folder').click();
        await press('ok');
        await until(() => !document.getElementById('out-dir').hidden, 5000);
        const savingShown = document.getElementById('out-dir-name').textContent === 'Picked' && pickerCalls[0] === 'readwrite';
        document.getElementById('out-dir-stop').click();
        await new Promise((r) => setTimeout(r, 200));
        const resumeOffered = !document.getElementById('out-dir-resume-bar').hidden;
        // Converting a folder: explained, then read-only access; "don't explain again" is remembered.
        document.getElementById('pick-folder').click();
        dialog.querySelector('#fs-dialog-skip').checked = true;
        await press('ok');
        await until(() => conv.items.length === 1, 5000);
        document.getElementById('clear').click();
        document.getElementById('pick-folder').click();
        await new Promise((r) => setTimeout(r, 300));
        const skippedSecondTime = !dialog.open;
        await until(() => conv.items.length === 1, 5000);
        const folderPicks = pickerCalls.slice(1);
        document.getElementById('clear').click();
        localStorage.removeItem('office-converter-skip-explanations');
        window.showDirectoryPicker = realDirPicker;

        return { dropped, explainedFirst, cancelled, savingShown, resumeOffered, skippedSecondTime, folderPicks,
                 watchStopped, refused, recalled, resolved, observed, newSaved, changedSaved, watchedPaths, polled,
                 pollerObserved: poller.observed, paths, first, second, third, names, tree: await tree(opfs), size: docx.length };
    }, fs.readFileSync(path.join(FIXTURES, 'sample.docx')).toString('base64'));
    const t = fsResult.tree;
    const fsChecks = [
        ['folder listing skips hidden files', JSON.stringify(fsResult.paths) === '["Docs/report.docx","Docs/sub/report.docx"]'],
        ['originals unchanged', t['Docs/report.docx'] === fsResult.size && t['Docs/sub/report.docx'] === fsResult.size],
        ['same format gets a new name', fsResult.first[0] === 'Docs/report (converted).docx' && t['Docs/report (converted).docx'] > 1000],
        ['result next to the original', fsResult.first[1] === 'Docs/sub/report.pdf' && t['Docs/sub/report.pdf'] > 1000],
        ['taken name is not replaced', fsResult.second[0] === 'Docs/sub/report (1).pdf' && t['Docs/sub/report (1).pdf'] > 1000],
        ['dropped folder: result next to the original', fsResult.dropped[0] === 'Docs/sub/report (2).pdf'],
        ['other folder keeps structure', fsResult.third[0] === 'Out/Docs/sub/report.pdf' && t['Out/Docs/sub/report.pdf'] > 1000],
        ['save dialog never replaces an original', fsResult.refused === 'SourceFileError restored'],
        ['handles remembered in IndexedDB', fsResult.recalled === true],
        ['resolve() inside a folder', fsResult.resolved === 'sub/report.docx'],
        ['watched folder: new file converted and saved', fsResult.newSaved === 'Docs/sub/new (converted).docx'],
        ['watched folder: changed file converted again', fsResult.changedSaved === 'Docs/report (converted) (1).docx'],
        ['watched folder: own results not picked up', JSON.stringify(fsResult.watchedPaths) === '["Docs/sub/new.docx"]'],
        ['watching without FileSystemObserver polls', !fsResult.pollerObserved && JSON.stringify(fsResult.polled) === '["sub/polled.docx"]'],
        ['watching stops', fsResult.watchStopped],
        ['saving into a folder is explained before the browser asks', fsResult.explainedFirst],
        ['cancelling the explanation asks nothing', fsResult.cancelled],
        ['saving shows where results go', fsResult.savingShown],
        ['the folder is offered again, not reused silently', fsResult.resumeOffered],
        ['folder conversion asks for read access only', JSON.stringify(fsResult.folderPicks) === '["read","read"]'],
        ['"don\'t explain again" is remembered', fsResult.skippedSecondTime],
        ['concurrent writes', JSON.stringify(fsResult.names) === '["a/x.txt","a/x (1).txt","a/x (2).txt"]'],
    ];
    for (const [name, ok] of fsChecks) {
        console.log(`${ok ? 'PASS' : 'FAIL'}  file system: ${name}`);
        if (!ok) failed++;
    }
    console.log(`      (folder watching used ${fsResult.observed ? 'FileSystemObserver' : 'polling'})`);
    if (fsChecks.some(([, ok]) => !ok)) console.log(JSON.stringify(fsResult, null, 1));

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

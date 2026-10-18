/* Service worker for the serverless office converter.
 *
 * Not registered directly: register a small script that sets self.OFFICE_ENGINE_DIR and
 * importScripts() this file (it must live at the root of the scope it should control).
 *
 * 1. Cross-origin isolation.  LibreOffice's WebAssembly build uses pthreads,
 *    which need SharedArrayBuffer, which browsers only expose to pages served
 *    with COOP/COEP headers.  GitHub Pages cannot set custom headers, so this
 *    worker adds them to every same-origin response.
 *
 * 2. LibreOffice binaries.  The build is stored as xz-compressed parts (each
 *    below GitHub's file size limits) described by lo/manifest.json.
 *    Requests for e.g. lo/soffice.wasm are answered by streaming the parts
 *    through an xz decoder, so the Emscripten loader sees plain files.  The
 *    decompressed files are kept in Cache Storage per build version, so the
 *    download (and decompression) happens only once per release.  Every file's SHA-256 is
 *    in the manifest; a cached copy is checked against it the first time this service
 *    worker serves it, and downloaded again if it doesn't match.  (The engine itself has no
 *    access to Cache Storage, see lockdown.js; this catches a damaged or replaced cache.)
 *
 * 3. Content Security Policy for the engine's workers.  LibreOffice parses untrusted
 *    documents; should one take over the engine, this policy leaves it no network except
 *    the engine's own files, and no way to load other scripts or start other workers.
 *    (lockdown.js also removes the storage APIs a policy cannot cover.)
 */
'use strict';

// Where the engine files (lo/, vendor/) are served from.  Set `self.OFFICE_ENGINE_DIR`
// (relative to the service worker's scope) in the script that imports this one;
// default: the scope root.
const ENGINE_DIR = new URL(self.OFFICE_ENGINE_DIR || './', self.registration.scope).href;
importScripts(ENGINE_DIR + 'vendor/xz-decompress.min.js');

const LO_DIR = ENGINE_DIR + 'lo/';
const MANIFEST_URL = LO_DIR + 'manifest.json';
// The engine's worker scripts, and their policy.  'unsafe-eval': Embind builds its glue
// functions with new Function().  engine-worker.js?network (OfficeEngine's isolateNetwork:
// false) goes without; only the page can start it, the policy allows no such worker.
// lo-pthread.js always has it.
const ENGINE_WORKER = ENGINE_DIR + 'engine-worker.js';
const ENGINE_THREAD = ENGINE_DIR + 'lo-pthread.js';
const ENGINE_CSP = [
    "default-src 'none'",
    `script-src ${ENGINE_DIR} 'unsafe-eval' 'wasm-unsafe-eval'`,
    `connect-src ${LO_DIR}`,
    `worker-src ${ENGINE_DIR}lo-pthread.js`,
].join('; ');
const CACHE_PREFIX = 'lo-assets-';
const progress = new BroadcastChannel('lo-assets');
// Cached files already checked against the manifest by this instance: hashing 145 MB on
// every engine start (one per document) would double the time it takes.
const verified = new Set();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'clear-cache') {
        event.waitUntil(clearCaches(null));
    }
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (request.method === 'GET' && url.href.startsWith(LO_DIR) && url.href !== MANIFEST_URL) {
        event.respondWith(serveLibreOfficeAsset(event, url));
    } else if (request.destination === 'worker' && isLockedDownWorker(url)) {
        event.respondWith(fetchIsolated(request, ENGINE_CSP));
    } else {
        event.respondWith(fetchIsolated(request));
    }
});

function isLockedDownWorker(url) {
    const path = url.origin + url.pathname;
    return path === ENGINE_THREAD || (path === ENGINE_WORKER && !url.searchParams.has('network'));
}

function isolationHeaders(headers) {
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    return headers;
}

async function fetchIsolated(request, csp) {
    const response = await fetch(request);
    if (response.status === 0) return response; // opaque; cannot be modified
    const headers = isolationHeaders(new Headers(response.headers));
    if (csp) headers.set('Content-Security-Policy', csp);
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

async function sha256(buffer) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
    return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

let manifestPromise = null;
let manifestFetchedAt = 0;

function loadManifest() {
    // A service worker instance is short-lived, but refresh anyway after a
    // while so a new deployment is picked up by a long-lived instance.
    if (!manifestPromise || Date.now() - manifestFetchedAt > 60_000) {
        manifestFetchedAt = Date.now();
        manifestPromise = fetch(MANIFEST_URL, { cache: 'no-cache' })
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)
            .then((manifest) => {
                if (manifest) clearCaches(CACHE_PREFIX + manifest.version);
                return manifest;
            });
    }
    return manifestPromise;
}

async function clearCaches(keep) {
    for (const name of await caches.keys()) {
        if (name.startsWith(CACHE_PREFIX) && name !== keep) await caches.delete(name);
    }
}

async function serveLibreOfficeAsset(event, url) {
    const manifest = await loadManifest();
    const name = url.href.slice(LO_DIR.length).split(/[?#]/)[0];
    const entry = manifest && manifest.files && manifest.files[name];
    if (!entry) {
        // Uncompressed development build (or file not in the manifest).
        return fetchIsolated(event.request);
    }
    const total = entry.compressedSize;
    const report = (loaded) => {
        progress.postMessage({ file: name, loaded, total, version: manifest.version });
    };
    const cache = await caches.open(CACHE_PREFIX + manifest.version);
    const cacheKey = LO_DIR + name;
    const checkKey = manifest.version + ' ' + name;
    let cached = await cache.match(cacheKey);
    if (cached && entry.sha256 && !verified.has(checkKey)) {
        if (await sha256(await cached.arrayBuffer()) === entry.sha256) {
            verified.add(checkKey);
            // Served straight from the cache (not from the buffer): the browser keeps
            // compiled WebAssembly for cached responses.
            cached = await cache.match(cacheKey);
        } else {
            console.warn('sw: cached ' + name + ' does not match the manifest; downloading it again');
            await cache.delete(cacheKey);
            cached = null;
        }
    }
    if (cached) {
        report(total);
        return cached;
    }

    const partUrls = entry.parts.map((p) => new URL(p, LO_DIR).href);
    let index = 0;
    let reader = null;
    let loaded = 0;
    let lastReport = 0;
    const compressed = new ReadableStream({
        async pull(controller) {
            for (;;) {
                if (!reader) {
                    if (index >= partUrls.length) {
                        report(loaded);
                        controller.close();
                        return;
                    }
                    const partUrl = partUrls[index++];
                    const response = await fetch(partUrl, { cache: 'no-cache' });
                    if (!response.ok) {
                        throw new Error('Fetching ' + partUrl + ' failed: ' + response.status);
                    }
                    reader = response.body.getReader();
                }
                const { done, value } = await reader.read();
                if (done) {
                    reader = null;
                    continue;
                }
                loaded += value.byteLength;
                if (Date.now() - lastReport > 150) {
                    lastReport = Date.now();
                    report(loaded);
                }
                controller.enqueue(value);
                return;
            }
        },
        cancel() {
            if (reader) reader.cancel();
        },
    });

    let body;
    if (entry.encoding === 'xz') {
        body = new self['xz-decompress'].XzReadableStream(compressed);
    } else if (entry.encoding === 'gzip') {
        body = compressed.pipeThrough(new DecompressionStream('gzip'));
    } else {
        body = compressed;
    }
    const headers = isolationHeaders(new Headers({
        'Content-Type': entry.type || 'application/octet-stream',
        'Content-Length': String(entry.size),
    }));
    // One copy goes to the page, the other into the cache for the next visit (only if it
    // is the file the manifest describes).
    const [forPage, forCache] = body.tee();
    event.waitUntil((async () => {
        const buffer = await new Response(forCache).arrayBuffer();
        if (entry.sha256 && await sha256(buffer) !== entry.sha256) {
            throw new Error('the download does not match the manifest');
        }
        await cache.put(cacheKey, new Response(buffer, { headers }));
        verified.add(checkKey);
    })().catch((e) => console.warn('sw: caching ' + name + ' failed', e)));
    return new Response(forPage, { status: 200, headers });
}

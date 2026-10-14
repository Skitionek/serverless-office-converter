/* Service worker for the serverless office converter.
 *
 * 1. Cross-origin isolation.  LibreOffice's WebAssembly build uses pthreads,
 *    which need SharedArrayBuffer, which browsers only expose to pages served
 *    with COOP/COEP headers.  GitHub Pages cannot set custom headers, so this
 *    worker adds them to every same-origin response.
 *
 * 2. LibreOffice binaries.  The build is stored as gzip-compressed parts
 *    (each below GitHub's file size limits) described by lo/manifest.json.
 *    Requests for e.g. lo/soffice.wasm are answered by streaming the parts
 *    through a DecompressionStream, so the Emscripten loader sees plain files.
 *    Downloaded parts are kept in Cache Storage per build version, so the
 *    ~100 MB download happens only once per release.
 */
'use strict';

const LO_DIR = new URL('lo/', self.registration.scope).href;
const MANIFEST_URL = LO_DIR + 'manifest.json';
const CACHE_PREFIX = 'lo-assets-';
const progress = new BroadcastChannel('lo-assets');

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
        event.respondWith(serveLibreOfficeAsset(request, url));
    } else {
        event.respondWith(fetchIsolated(request));
    }
});

function isolationHeaders(headers) {
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    return headers;
}

async function fetchIsolated(request) {
    const response = await fetch(request);
    if (response.status === 0) return response; // opaque; cannot be modified
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: isolationHeaders(new Headers(response.headers)),
    });
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

async function serveLibreOfficeAsset(request, url) {
    const manifest = await loadManifest();
    const name = url.href.slice(LO_DIR.length).split(/[?#]/)[0];
    const entry = manifest && manifest.files && manifest.files[name];
    if (!entry) {
        // Uncompressed development build (or file not in the manifest).
        return fetchIsolated(request);
    }
    const cache = await caches.open(CACHE_PREFIX + manifest.version);
    const partUrls = entry.parts.map((p) => new URL(p, LO_DIR).href);
    const total = entry.compressedSize;
    let loaded = 0;
    let lastReport = 0;
    const report = (force) => {
        const now = Date.now();
        if (force || now - lastReport > 150) {
            lastReport = now;
            progress.postMessage({ file: name, loaded, total, version: manifest.version });
        }
    };

    let index = 0;
    let reader = null;
    let chunks = null;
    let currentUrl = null;

    const compressed = new ReadableStream({
        async pull(controller) {
            for (;;) {
                if (!reader) {
                    if (index >= partUrls.length) {
                        report(true);
                        controller.close();
                        return;
                    }
                    currentUrl = partUrls[index++];
                    let response = await cache.match(currentUrl);
                    chunks = null;
                    if (!response) {
                        response = await fetch(currentUrl, { cache: 'no-cache' });
                        if (!response.ok) {
                            throw new Error('Fetching ' + currentUrl + ' failed: ' + response.status);
                        }
                        chunks = []; // collect to store in the cache once complete
                    }
                    reader = response.body.getReader();
                }
                const { done, value } = await reader.read();
                if (done) {
                    reader = null;
                    if (chunks) {
                        await cache.put(currentUrl, new Response(new Blob(chunks), {
                            headers: { 'Content-Type': 'application/octet-stream' },
                        }));
                        chunks = null;
                    }
                    continue;
                }
                if (chunks) chunks.push(value);
                loaded += value.byteLength;
                report(false);
                controller.enqueue(value);
                return;
            }
        },
        cancel() {
            if (reader) reader.cancel();
        },
    });

    const body = entry.encoding === 'gzip'
        ? compressed.pipeThrough(new DecompressionStream('gzip'))
        : compressed;
    const headers = isolationHeaders(new Headers({
        'Content-Type': entry.type || 'application/octet-stream',
        'Content-Length': String(entry.size),
        'Cache-Control': 'no-store',
    }));
    return new Response(body, { status: 200, headers });
}

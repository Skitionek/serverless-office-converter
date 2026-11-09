import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import { FontDownloader } from '../../web/office-converter/font-download.js';

const FONT_URL = 'https://cdn.example/fonts/Lato.ttf';
const FONT_BYTES = Uint8Array.from([0, 1, 0, 0, 9, 9, 9, 9]);
const FONT_SHA256 = crypto.createHash('sha256').update(FONT_BYTES).digest('hex');

function fakeNetwork(routes) {
    const requested = [];
    const fetchFont = async (url) => {
        requested.push(url);
        const body = routes[url];
        if (!body) return new Response('missing', { status: 404 });
        return new Response(body, { status: 200 });
    };
    return { fetchFont, requested };
}

// The parts of the Cache API the downloader uses.
function fakeCache() {
    const stored = new Map();
    return {
        stored,
        async match(url) {
            const bytes = stored.get(url);
            return bytes ? new Response(bytes) : undefined;
        },
        async put(url, response) {
            stored.set(url, new Uint8Array(await response.arrayBuffer()));
        },
    };
}

describe('FontDownloader.load', () => {
    it('downloads a font whose hash matches the catalog and keeps it in the cache', async () => {
        // Given a CDN that serves the font and an empty cache
        const network = fakeNetwork({ [FONT_URL]: FONT_BYTES });
        const cache = fakeCache();
        const downloader = new FontDownloader({ fetchFont: network.fetchFont, openCache: async () => cache });

        // When the font is loaded
        const bytes = await downloader.load({ url: FONT_URL, sha256: FONT_SHA256 });

        // Then the bytes come back and are stored for next time
        assert.deepEqual(bytes, FONT_BYTES);
        assert.deepEqual(cache.stored.get(FONT_URL), FONT_BYTES);
    });

    it('does not touch the network for a font that is already cached', async () => {
        // Given a cache that holds the font and a network that fails the test if used
        const network = fakeNetwork({});
        const cache = fakeCache();
        cache.stored.set(FONT_URL, FONT_BYTES);
        const downloader = new FontDownloader({ fetchFont: network.fetchFont, openCache: async () => cache });

        // When the font is loaded
        const bytes = await downloader.load({ url: FONT_URL, sha256: FONT_SHA256 });

        // Then it comes from the cache
        assert.deepEqual(bytes, FONT_BYTES);
        assert.deepEqual(network.requested, []);
    });

    it('refuses bytes that do not match the catalog hash, and does not cache them', async () => {
        // Given a CDN that serves something other than the catalogued font
        const network = fakeNetwork({ [FONT_URL]: Uint8Array.from([6, 6, 6]) });
        const cache = fakeCache();
        const downloader = new FontDownloader({ fetchFont: network.fetchFont, openCache: async () => cache });

        // When the font is loaded
        const load = downloader.load({ url: FONT_URL, sha256: FONT_SHA256 });

        // Then it is rejected and nothing is stored
        await assert.rejects(load, /does not match/);
        assert.equal(cache.stored.size, 0);
    });

    it('reports a CDN error instead of returning an error page as a font', async () => {
        // Given a CDN that does not have the file
        const network = fakeNetwork({});
        const downloader = new FontDownloader({ fetchFont: network.fetchFont, openCache: async () => fakeCache() });

        // When the font is loaded
        const load = downloader.load({ url: FONT_URL, sha256: FONT_SHA256 });

        // Then the status is reported
        await assert.rejects(load, /404/);
    });

    it('still loads fonts when the browser offers no cache', async () => {
        // Given a browser whose Cache Storage is unavailable (private mode, for example)
        const network = fakeNetwork({ [FONT_URL]: FONT_BYTES });
        const downloader = new FontDownloader({
            fetchFont: network.fetchFont,
            openCache: async () => { throw new Error('SecurityError'); },
        });

        // When the font is loaded twice
        const first = await downloader.load({ url: FONT_URL, sha256: FONT_SHA256 });
        const second = await downloader.load({ url: FONT_URL, sha256: FONT_SHA256 });

        // Then it works, downloading each time
        assert.deepEqual(first, FONT_BYTES);
        assert.deepEqual(second, FONT_BYTES);
        assert.equal(network.requested.length, 2);
    });
});

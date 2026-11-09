/* Downloads font files for the engine.
 *
 * A file is accepted only if its SHA-256 is the one in the catalog, so what
 * reaches LibreOffice's font parser is exactly what was catalogued.  Accepted
 * files go into Cache Storage, so each font is downloaded once and works
 * offline afterwards.  Fonts are versioned by their URL and never change, so
 * the cache needs no expiry.
 */

const DEFAULT_CACHE_NAME = 'office-fonts-v1';

function toHex(buffer) {
    return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class FontDownloader {
    /**
     * @param {object} [options]
     * @param {typeof fetch} [options.fetchFont] How to fetch a URL (the CDN must send CORS headers).
     * @param {null | (() => Promise<Cache>)} [options.openCache] Opens the cache; null for none.
     */
    constructor({
        fetchFont = (url) => fetch(url),
        openCache = () => caches.open(DEFAULT_CACHE_NAME),
    } = {}) {
        this.fetchFont = fetchFont;
        this.openCache = openCache;
    }

    // Cache Storage can be missing or throw (private windows, blocked storage): then
    // there is simply no cache.
    async #cache() {
        if (!this.openCache) return null;
        try {
            return await this.openCache();
        } catch (unavailable) {
            return null;
        }
    }

    /**
     * @param {{url: string, sha256: string}} file
     * @returns {Promise<Uint8Array>} The font file.
     */
    async load({ url, sha256 }) {
        const cache = await this.#cache();

        const cached = cache && await cache.match(url);
        if (cached) return new Uint8Array(await cached.arrayBuffer());

        const response = await this.fetchFont(url);
        if (!response.ok) {
            throw new Error('Fetching the font ' + url + ' failed: HTTP ' + response.status);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());

        const digest = toHex(await crypto.subtle.digest('SHA-256', bytes));
        if (digest !== sha256) {
            throw new Error('The font ' + url + ' does not match the catalog (sha256 ' + digest + ').');
        }

        if (cache) {
            // A full disk must not fail the conversion; the font was fetched, use it.
            await cache.put(url, new Response(bytes, { headers: { 'Content-Type': 'font/ttf' } }))
                .catch(() => {});
        }
        return bytes;
    }
}

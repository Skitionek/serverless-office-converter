/* Downloads font files for the engine.
 *
 * A file is accepted only if its SHA-256 is the one in the catalog, so what
 * reaches LibreOffice's font parser is exactly what was catalogued.  That holds
 * for a cached copy too: it is checked again, and fetched again if it differs.
 * Accepted files go into Cache Storage, so each font is downloaded once and
 * works offline afterwards.  Fonts are versioned by their URL and never
 * change, so the cache needs no expiry.  The catalog is kept there as well,
 * because offline the fonts are only found through it.
 */

const DEFAULT_CACHE_NAME = 'office-fonts-v1';

async function sha256Of(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
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
     * The font catalog, from the network if possible, otherwise the copy kept from the last
     * time, so that fonts that were downloaded before still work offline.
     * @param {string} url
     * @param {typeof fetch} fetchCatalog
     * @returns {Promise<object>}
     */
    async loadCatalogJson(url, fetchCatalog) {
        const cache = await this.#cache();
        try {
            const response = await fetchCatalog(url);
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const text = await response.text();
            const json = JSON.parse(text);
            if (cache) {
                await cache.put(url, new Response(text, { headers: { 'Content-Type': 'application/json' } }))
                    .catch(() => {});
            }
            return json;
        } catch (error) {
            const stored = cache && await cache.match(url);
            if (!stored) throw error;
            return stored.json();
        }
    }

    /**
     * @param {{url: string, sha256: string}} file
     * @returns {Promise<Uint8Array>} The font file.
     */
    async load({ url, sha256 }) {
        const cache = await this.#cache();

        const cached = cache && await cache.match(url);
        if (cached) {
            const stored = new Uint8Array(await cached.arrayBuffer());
            // A copy that does not match the catalog (older, damaged) is not trusted: fetch it again.
            if (await sha256Of(stored) === sha256) return stored;
        }

        const response = await this.fetchFont(url);
        if (!response.ok) {
            throw new Error('Fetching the font ' + url + ' failed: HTTP ' + response.status);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());

        const digest = await sha256Of(bytes);
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

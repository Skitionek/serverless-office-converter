/* Decides which fonts a document needs beyond the ones bundled with the
 * engine, downloads them, and wraps each in a carrier (font-carrier.js) ready
 * for the engine to hand to LibreOffice.
 *
 * Failing to get a font never fails a conversion: LibreOffice then uses its
 * built-in substitute, as it always did.
 */

import { buildFontCarrier } from './font-carrier.js';
import { FontCatalog } from './font-catalog.js';
import { FontDownloader } from './font-download.js';
import { detectFontNeeds } from './font-needs.js';

export class OnDemandFonts {
    /**
     * @param {object} options
     * @param {string} options.catalogUrl Where font-catalog.json is.
     * @param {Record<string, string>} [options.sources] Mirror base URLs by source name.
     * @param {FontDownloader} [options.downloader]
     * @param {typeof fetch} [options.fetchCatalog]
     * @param {(...message: string[]) => void} [options.warn]
     */
    constructor({
        catalogUrl,
        sources = {},
        downloader = new FontDownloader(),
        fetchCatalog = (url) => fetch(url),
        warn = (...message) => console.warn(...message),
    }) {
        this.catalogUrl = catalogUrl;
        this.sources = sources;
        this.downloader = downloader;
        this.fetchCatalog = fetchCatalog;
        this.warn = warn;
        this.catalogPromise = null;
    }

    // Loaded on first use, once; null when it cannot be loaded.
    #catalog() {
        if (!this.catalogPromise) {
            this.catalogPromise = this.#loadCatalog().catch((error) => {
                this.warn('On-demand fonts are off: the font catalog could not be loaded (' + error.message + ').');
                return null;
            });
        }
        return this.catalogPromise;
    }

    async #loadCatalog() {
        const response = await this.fetchCatalog(this.catalogUrl);
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return new FontCatalog(await response.json(), { sources: this.sources });
    }

    async #carrierFor(font) {
        const files = await Promise.all(font.files.map((file) => this.downloader.load(file)));
        return { id: font.id, family: font.family, carrier: buildFontCarrier(font.family, files) };
    }

    /**
     * Fonts the document needs that the engine does not have yet, ready to register.
     * @param {Uint8Array} bytes The document.
     * @param {Set<string>} have Ids of the fonts already registered with the engine.
     * @returns {Promise<{id: string, family: string, carrier: Uint8Array}[]>}
     */
    async prepare(bytes, have) {
        const catalog = await this.#catalog();
        if (!catalog) return [];

        const needs = await detectFontNeeds(bytes, { scripts: catalog.scriptsToDetect() });
        const missing = catalog.fontsFor(needs).filter((font) => !have.has(font.id));

        const attempts = await Promise.all(missing.map((font) =>
            this.#carrierFor(font).catch((error) => {
                this.warn('Font "' + font.family + '" could not be loaded (' + error.message + '); '
                    + 'the document will use a substitute.');
                return null;
            })));
        return attempts.filter(Boolean);
    }
}

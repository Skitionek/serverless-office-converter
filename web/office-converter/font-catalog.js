/* The catalog of fonts that are loaded on demand, and what it takes to pick
 * the right ones for a document.
 *
 * font-catalog.json (written by build/make-font-catalog.py) looks like:
 *
 *   {
 *     "format": 1,
 *     "sources": { "npm": "https://cdn.jsdelivr.net/npm/" },
 *     "families": { "Open Sans": { "source": "npm", "files": [
 *         { "path": "@expo-google-fonts/open-sans@0.4.2/400Regular/OpenSans_400Regular.ttf",
 *           "size": 130832, "sha256": "…" } ] } },
 *     "aliases": { "Georgia": "Gelasio" },
 *     "scripts": { "Thai": "Noto Sans Thai", "Han": "Noto Sans SC", "Han-Hant": "Noto Sans TC" }
 *   }
 *
 * A file's URL is its source's base URL plus its path; the path names an npm package at an exact
 * version, so the file never changes.  A source can be replaced with a mirror (see FontCatalog).
 *
 * A file is only ever used when the bytes downloaded from the CDN have the
 * recorded sha256 (see font-download.js), so a CDN that changes or is
 * compromised can make a font unavailable but cannot feed anything else to
 * LibreOffice's font parser.
 */

const SUPPORTED_FORMAT = 1;

// Scripts whose fonts also draw Han characters (Japanese and Korean fonts do).
const SCRIPTS_WITH_OWN_HAN = ['Hiragana', 'Katakana', 'Hangul'];

// "Open Sans", "open-sans" and "OPEN SANS" are the same family.
function normalizeFamily(name) {
    return name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

// Escape each path segment, but leave "," and "@" alone (as in "@scope/name@1.0.0/Font[wdth,wght].ttf"):
// that is the spelling npm CDNs such as jsDelivr and unpkg serve.
function encodePath(path) {
    return path.split('/')
        .map((segment) => encodeURIComponent(segment).replace(/%2C/g, ',').replace(/%40/g, '@'))
        .join('/');
}

export class FontCatalog {
    /**
     * @param {object} json The parsed font-catalog.json.
     * @param {{sources?: Record<string, string>}} [options] Replacement base URLs by source
     *   name, to serve fonts from a mirror.
     */
    constructor(json, { sources = {} } = {}) {
        if (json.format !== SUPPORTED_FORMAT) {
            throw new Error('Unsupported font catalog format: ' + json.format);
        }
        this.json = json;
        this.sources = { ...json.sources, ...sources };
        this.familyByKey = new Map(
            Object.keys(json.families).map((name) => [normalizeFamily(name), name]));
        this.aliasByKey = new Map(
            Object.entries(json.aliases || {}).map(([name, target]) => [normalizeFamily(name), target]));
    }

    /** Unicode script names the catalog has fonts for ("Han-Hant" is a variant of Han, not a script). */
    scriptsToDetect() {
        return Object.keys(this.json.scripts || {}).filter((name) => !name.includes('-'));
    }

    /**
     * The fonts a document needs, as {id, family, files: [{url, size, sha256}]}.
     * `family` is the name to register the font under; `id` identifies it
     * (names that differ only in case or spacing are one font).
     * @param {{families: string[], scripts: string[], traditionalChinese: boolean}} needs
     */
    fontsFor({ families, scripts, traditionalChinese }) {
        const wanted = new Map(); // id -> { family, catalogName }

        const want = (family, catalogName) => {
            const id = normalizeFamily(family);
            if (!wanted.has(id)) wanted.set(id, { family, catalogName });
        };

        for (const name of families) {
            const key = normalizeFamily(name);
            if (this.aliasByKey.has(key)) {
                want(name, this.aliasByKey.get(key));
            } else if (this.familyByKey.has(key)) {
                const catalogName = this.familyByKey.get(key);
                want(catalogName, catalogName);
            }
        }

        const hasOwnHan = scripts.some((script) => SCRIPTS_WITH_OWN_HAN.includes(script));
        for (const script of scripts) {
            if (script === 'Han' && hasOwnHan) continue;
            const variant = script === 'Han' && traditionalChinese ? 'Han-Hant' : script;
            const catalogName = (this.json.scripts || {})[variant];
            if (catalogName) want(catalogName, catalogName);
        }

        return [...wanted].flatMap(([id, { family, catalogName }]) => {
            const entry = this.json.families[catalogName];
            if (!entry) return []; // an alias or script pointing at a family the catalog lacks
            const base = this.sources[entry.source];
            const files = entry.files.map((file) => ({
                url: new URL(encodePath(file.path), base).href,
                size: file.size,
                sha256: file.sha256,
            }));
            return [{ id, family, files }];
        });
    }
}

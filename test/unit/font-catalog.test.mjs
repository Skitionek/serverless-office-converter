import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FontCatalog } from '../../web/office-converter/font-catalog.js';

const SHA = (letter) => letter.repeat(64);

function sampleCatalogJson() {
    return {
        format: 1,
        sources: {
            'google-fonts': 'https://cdn.example/gh/google/fonts@main/',
            dejavu: 'https://cdn.example/npm/dejavu@1/ttf/',
        },
        families: {
            'Open Sans': {
                source: 'google-fonts',
                files: [
                    { path: 'ofl/opensans/OpenSans[wdth,wght].ttf', size: 100, sha256: SHA('a') },
                    { path: 'ofl/opensans/OpenSans-Italic[wdth,wght].ttf', size: 110, sha256: SHA('b') },
                ],
            },
            Gelasio: {
                source: 'google-fonts',
                files: [{ path: 'ofl/gelasio/Gelasio[wght].ttf', size: 50, sha256: SHA('c') }],
            },
            'DejaVu Serif': {
                source: 'dejavu',
                files: [{ path: 'DejaVuSerif.ttf', size: 70, sha256: SHA('d') }],
            },
            'Noto Sans JP': {
                source: 'google-fonts',
                files: [{ path: 'ofl/notosansjp/NotoSansJP[wght].ttf', size: 900, sha256: SHA('e') }],
            },
            'Noto Sans KR': {
                source: 'google-fonts',
                files: [{ path: 'ofl/notosanskr/NotoSansKR[wght].ttf', size: 800, sha256: SHA('f') }],
            },
            'Noto Sans SC': {
                source: 'google-fonts',
                files: [{ path: 'ofl/notosanssc/NotoSansSC[wght].ttf', size: 950, sha256: SHA('1') }],
            },
            'Noto Sans TC': {
                source: 'google-fonts',
                files: [{ path: 'ofl/notosanstc/NotoSansTC[wght].ttf', size: 960, sha256: SHA('2') }],
            },
            'Noto Sans Thai': {
                source: 'google-fonts',
                files: [{ path: 'ofl/notosansthai/NotoSansThai[wdth,wght].ttf', size: 60, sha256: SHA('3') }],
            },
        },
        aliases: { Georgia: 'Gelasio' },
        scripts: {
            Hiragana: 'Noto Sans JP',
            Katakana: 'Noto Sans JP',
            Hangul: 'Noto Sans KR',
            Han: 'Noto Sans SC',
            'Han-Hant': 'Noto Sans TC',
            Thai: 'Noto Sans Thai',
        },
    };
}

function needs(overrides) {
    return { families: [], scripts: [], traditionalChinese: false, ...overrides };
}

describe('FontCatalog.fontsFor: families', () => {
    it('returns the files of a family the document names, with CDN URLs', () => {
        // Given a catalog with Open Sans
        const catalog = new FontCatalog(sampleCatalogJson());

        // When a document needs Open Sans
        const fonts = catalog.fontsFor(needs({ families: ['Open Sans'] }));

        // Then both its files are returned, with brackets and commas of variable fonts escaped sensibly
        assert.equal(fonts.length, 1);
        assert.equal(fonts[0].family, 'Open Sans');
        assert.deepEqual(fonts[0].files.map((file) => file.url), [
            'https://cdn.example/gh/google/fonts@main/ofl/opensans/OpenSans%5Bwdth,wght%5D.ttf',
            'https://cdn.example/gh/google/fonts@main/ofl/opensans/OpenSans-Italic%5Bwdth,wght%5D.ttf',
        ]);
        assert.equal(fonts[0].files[0].sha256, SHA('a'));
        assert.equal(fonts[0].files[0].size, 100);
    });

    it('matches names regardless of case, spaces and punctuation', () => {
        // Given a catalog with Open Sans
        const catalog = new FontCatalog(sampleCatalogJson());

        // When a document spells the name differently
        const fonts = catalog.fontsFor(needs({ families: ['OPEN SANS', 'open-sans'] }));

        // Then it is still one family
        assert.deepEqual(fonts.map((font) => font.family), ['Open Sans']);
    });

    it('ignores families that are not in the catalog', () => {
        // Given a catalog without Arial, and a generic family name
        const catalog = new FontCatalog(sampleCatalogJson());

        // When a document needs Arial and sans-serif
        const fonts = catalog.fontsFor(needs({ families: ['Arial', 'sans-serif', '+mn-lt'] }));

        // Then nothing is returned, so nothing is downloaded
        assert.deepEqual(fonts, []);
    });

    it('registers an alias under the name the document uses', () => {
        // Given a catalog where Georgia is served by the metric-compatible Gelasio
        const catalog = new FontCatalog(sampleCatalogJson());

        // When a document needs Georgia
        const fonts = catalog.fontsFor(needs({ families: ['Georgia'] }));

        // Then Gelasio's file is returned under the name "Georgia"
        assert.equal(fonts[0].family, 'Georgia');
        assert.match(fonts[0].files[0].url, /Gelasio/);
    });

    it('returns each family once even when named several ways', () => {
        // Given a document that names Gelasio and Georgia (an alias of it)
        const catalog = new FontCatalog(sampleCatalogJson());

        // When the needs are resolved
        const fonts = catalog.fontsFor(needs({ families: ['Gelasio', 'Georgia', 'Gelasio'] }));

        // Then both names are served, each once
        assert.deepEqual(fonts.map((font) => font.family).sort(), ['Gelasio', 'Georgia']);
    });

    it('uses the base URL of the family\'s own source', () => {
        // Given a family served from a second source
        const catalog = new FontCatalog(sampleCatalogJson());

        // When it is needed
        const fonts = catalog.fontsFor(needs({ families: ['DejaVu Serif'] }));

        // Then its URL starts with that source
        assert.equal(fonts[0].files[0].url, 'https://cdn.example/npm/dejavu@1/ttf/DejaVuSerif.ttf');
    });

    it('keeps the "@" of npm scopes and versions in the URL', () => {
        // Given a family that lives in a scoped, versioned npm package
        const json = sampleCatalogJson();
        json.families.Lora = {
            source: 'google-fonts',
            files: [{ path: '@expo-google-fonts/lora@0.4.1/400Regular/Lora_400Regular.ttf', size: 1, sha256: SHA('9') }],
        };
        const catalog = new FontCatalog(json);

        // When it is needed
        const fonts = catalog.fontsFor(needs({ families: ['Lora'] }));

        // Then the scope and version are spelled the way npm CDNs serve them
        assert.equal(fonts[0].files[0].url,
            'https://cdn.example/gh/google/fonts@main/@expo-google-fonts/lora@0.4.1/400Regular/Lora_400Regular.ttf');
    });

    it('lets the embedder point a source at its own mirror', () => {
        // Given a catalog and a mirror for one source
        const catalog = new FontCatalog(sampleCatalogJson(),
            { sources: { 'google-fonts': 'https://mirror.test/fonts/' } });

        // When a family of that source is needed
        const fonts = catalog.fontsFor(needs({ families: ['Gelasio'] }));

        // Then the mirror is used
        assert.equal(fonts[0].files[0].url, 'https://mirror.test/fonts/ofl/gelasio/Gelasio%5Bwght%5D.ttf');
    });
});

describe('FontCatalog.fontsFor: scripts', () => {
    it('maps scripts to the fonts that draw them', () => {
        // Given a document with Thai text
        const catalog = new FontCatalog(sampleCatalogJson());

        // When its needs are resolved
        const fonts = catalog.fontsFor(needs({ scripts: ['Thai'] }));

        // Then the Thai font is returned
        assert.deepEqual(fonts.map((font) => font.family), ['Noto Sans Thai']);
    });

    it('uses one font for hiragana and katakana', () => {
        // Given a Japanese document
        const catalog = new FontCatalog(sampleCatalogJson());

        // When its needs are resolved
        const fonts = catalog.fontsFor(needs({ scripts: ['Hiragana', 'Katakana', 'Han'] }));

        // Then only the Japanese font is returned: it also draws the Han characters
        assert.deepEqual(fonts.map((font) => font.family), ['Noto Sans JP']);
    });

    it('does not add a Chinese font when Korean text carries its own Han characters', () => {
        // Given a Korean document with some hanja
        const catalog = new FontCatalog(sampleCatalogJson());

        // When its needs are resolved
        const fonts = catalog.fontsFor(needs({ scripts: ['Hangul', 'Han'] }));

        // Then only the Korean font is returned
        assert.deepEqual(fonts.map((font) => font.family), ['Noto Sans KR']);
    });

    it('picks Simplified Chinese for Han text, Traditional when the document says so', () => {
        // Given Han-only text
        const catalog = new FontCatalog(sampleCatalogJson());

        // When it is marked Traditional or not
        const simplified = catalog.fontsFor(needs({ scripts: ['Han'] }));
        const traditional = catalog.fontsFor(needs({ scripts: ['Han'], traditionalChinese: true }));

        // Then the matching font is returned
        assert.deepEqual(simplified.map((font) => font.family), ['Noto Sans SC']);
        assert.deepEqual(traditional.map((font) => font.family), ['Noto Sans TC']);
    });

    it('lists the real Unicode scripts it can serve, for the detector to look for', () => {
        // Given a catalog
        const catalog = new FontCatalog(sampleCatalogJson());

        // When asked which scripts to detect
        const scripts = catalog.scriptsToDetect();

        // Then "Han-Hant" (a variant, not a Unicode script) is not among them
        assert.deepEqual(scripts.sort(), ['Han', 'Hangul', 'Hiragana', 'Katakana', 'Thai']);
    });
});

describe('FontCatalog', () => {
    it('rejects a catalog in a format it does not know', () => {
        // Given a catalog from the future
        const json = { ...sampleCatalogJson(), format: 2 };

        // When it is loaded
        const load = () => new FontCatalog(json);

        // Then it is refused, rather than guessed at
        assert.throws(load, /format/);
    });
});

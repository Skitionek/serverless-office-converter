import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { FontCatalog } from '../../web/office-converter/font-catalog.js';

const CATALOG_PATH = path.resolve(import.meta.dirname, '..', '..', 'web', 'office-converter', 'font-catalog.json');
const json = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));

// Fonts that ship inside the engine; the catalog must not offer them a second time.
const BUNDLED_FAMILIES = [
    'Liberation Sans', 'Liberation Serif', 'Liberation Mono', 'Liberation Sans Narrow',
    'DejaVu Sans', 'Carlito', 'Caladea', 'OpenSymbol',
];

describe('the committed font-catalog.json', () => {
    it('is a catalog the engine accepts', () => {
        // Given the catalog file in the repository
        // When the engine's catalog class reads it
        const load = () => new FontCatalog(json);

        // Then it is accepted
        assert.doesNotThrow(load);
    });

    it('describes every file with a size and a SHA-256 the downloader can check', () => {
        // Given the catalog's families
        const files = Object.values(json.families).flatMap((family) => family.files);

        // When each file entry is inspected
        // Then each has a path, a positive size and a 64-digit hash
        assert.ok(files.length > 0);
        for (const file of files) {
            assert.match(file.path, /\.ttf$/);
            assert.ok(file.size > 0, file.path);
            assert.match(file.sha256, /^[0-9a-f]{64}$/, file.path);
        }
    });

    it('uses only sources it defines', () => {
        // Given the catalog's families and its sources
        // When each family's source is looked up
        // Then it exists, and is an https URL ending in a slash
        for (const [name, family] of Object.entries(json.families)) {
            const base = json.sources[family.source];
            assert.match(base, /^https:\/\/.+\/$/, name);
        }
    });

    it('points every alias and script at a family it has', () => {
        // Given the aliases and script mappings
        const targets = [...Object.values(json.aliases), ...Object.values(json.scripts)];

        // When each target is looked up
        // Then it is a family of the catalog
        for (const target of targets) assert.ok(json.families[target], target);
    });

    it('does not offer the fonts that are bundled with the engine', () => {
        // Given the list of bundled families
        // When the catalog's families are compared with it
        const duplicated = BUNDLED_FAMILIES.filter((name) => json.families[name]);

        // Then none is offered again: on-demand fonts are the ones the engine does not carry
        assert.deepEqual(duplicated, []);
    });

    it('can serve Chinese, Japanese and Korean text, the main reason fonts load on demand', () => {
        // Given the script mappings
        // When the CJK scripts are looked up
        // Then each has a font
        for (const script of ['Han', 'Han-Hant', 'Hiragana', 'Katakana', 'Hangul']) {
            assert.ok(json.scripts[script], script);
        }
    });
});

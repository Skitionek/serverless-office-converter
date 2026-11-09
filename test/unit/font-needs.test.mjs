import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { detectFontNeeds } from '../../web/office-converter/font-needs.js';
import { deflatedZip, oleFileWithUtf16Text, utf8 } from './helpers.mjs';

const FIXTURES = path.resolve(import.meta.dirname, '..', 'fixtures');
const ALL_SCRIPTS = ['Han', 'Hiragana', 'Katakana', 'Hangul', 'Thai', 'Devanagari'];

function fixture(name) {
    return new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));
}

describe('detectFontNeeds: font families', () => {
    it('reads the families a DOCX sets on its runs, including the east-Asian one', async () => {
        // Given a DOCX whose runs use Roboto and, for east-Asian text, Yu Mincho
        const docx = deflatedZip([
            { name: '[Content_Types].xml', text: '<Types/>' },
            {
                name: 'word/document.xml',
                text: '<w:p><w:r><w:rPr><w:rFonts w:ascii="Roboto" w:hAnsi="Roboto" '
                    + 'w:eastAsia="Yu Mincho" w:cs="Arial"/></w:rPr><w:t>Hello</w:t></w:r></w:p>',
            },
        ]);

        // When the font needs are detected
        const needs = await detectFontNeeds(docx, { scripts: [] });

        // Then every family the document names is reported once
        assert.deepEqual([...needs.families].sort(), ['Arial', 'Roboto', 'Yu Mincho']);
    });

    it('reads the typeface of a PPTX theme and slide', async () => {
        // Given a PPTX with a theme font and a slide font
        const pptx = deflatedZip([
            { name: 'ppt/theme/theme1.xml', text: '<a:latin typeface="Montserrat"/>' },
            { name: 'ppt/slides/slide1.xml', text: '<a:latin typeface="Lato Light"/>' },
        ]);

        // When the font needs are detected
        const needs = await detectFontNeeds(pptx, { scripts: [] });

        // Then both are reported
        assert.deepEqual([...needs.families].sort(), ['Lato Light', 'Montserrat']);
    });

    it('reads the font name of an XLSX style sheet', async () => {
        // Given an XLSX style sheet with a font name
        const xlsx = deflatedZip([
            { name: 'xl/styles.xml', text: '<fonts><font><sz val="11"/><name val="Source Sans 3"/></font></fonts>' },
        ]);

        // When the font needs are detected
        const needs = await detectFontNeeds(xlsx, { scripts: [] });

        // Then the family is reported
        assert.deepEqual(needs.families, ['Source Sans 3']);
    });

    it('reads ODF font declarations, with their XML-escaped quotes', async () => {
        // Given an ODT whose styles declare families the way LibreOffice writes them
        const odt = deflatedZip([
            {
                name: 'content.xml',
                text: '<style:font-face style:name="Open Sans" svg:font-family="&apos;Open Sans&apos;"/>'
                    + '<style:text-properties style:font-name="Lora" fo:font-family="&apos;Lora&apos;"/>',
            },
        ]);

        // When the font needs are detected
        const needs = await detectFontNeeds(odt, { scripts: [] });

        // Then the quotes are gone and each family is reported once
        assert.deepEqual([...needs.families].sort(), ['Lora', 'Open Sans']);
    });

    it('reads every family of a CSS font stack in an HTML file', async () => {
        // Given an HTML file with a font stack
        const html = utf8('<p style="font-family: \'Fira Sans\', Roboto, sans-serif">Hi</p>'
            + '<font face="Lato">Hi</font>');

        // When the font needs are detected
        const needs = await detectFontNeeds(html, { scripts: [] });

        // Then the stack is split into families; the generic one is left in, for the catalog to ignore
        assert.deepEqual([...needs.families].sort(), ['Fira Sans', 'Lato', 'Roboto', 'sans-serif']);
    });

    it('reads the font table of an RTF file', async () => {
        // Given an RTF file with a font table
        const rtf = utf8('{\\rtf1\\ansi{\\fonttbl{\\f0\\froman\\fcharset0 Merriweather;}'
            + '{\\f1\\fswiss\\fprq2\\fcharset0 Open Sans;}}\\f0 Hello}');

        // When the font needs are detected
        const needs = await detectFontNeeds(rtf, { scripts: [] });

        // Then both families are reported
        assert.deepEqual([...needs.families].sort(), ['Merriweather', 'Open Sans']);
    });

    it('finds the real families in the sample documents', async () => {
        // Given real documents made by Word-like tools and by LibreOffice
        const docx = fixture('sample.docx');
        const ods = fixture('matrix/sample.ods');

        // When their font needs are detected
        const docxNeeds = await detectFontNeeds(docx, { scripts: [] });
        const odsNeeds = await detectFontNeeds(ods, { scripts: [] });

        // Then the families they use are there
        assert.ok(docxNeeds.families.includes('Arial'));
        assert.ok(odsNeeds.families.includes('Liberation Sans'));
        assert.ok(odsNeeds.families.includes('DejaVu Sans'));
    });

    it('reports no family for a plain text file', async () => {
        // Given text that merely mentions a font
        const text = utf8('I like Roboto and Arial.\n');

        // When the font needs are detected
        const needs = await detectFontNeeds(text, { scripts: [] });

        // Then no family counts as needed, because nothing in the file sets a font
        assert.deepEqual(needs.families, []);
    });
});

describe('detectFontNeeds: scripts', () => {
    it('detects Japanese text in a DOCX by its kana', async () => {
        // Given a DOCX with Japanese text
        const docx = deflatedZip([{ name: 'word/document.xml', text: '<w:t>こんにちは世界</w:t>' }]);

        // When the font needs are detected
        const needs = await detectFontNeeds(docx, { scripts: ALL_SCRIPTS });

        // Then hiragana and han are reported, not katakana or hangul
        assert.deepEqual([...needs.scripts].sort(), ['Han', 'Hiragana']);
    });

    it('detects Korean and Thai text in a plain text file', async () => {
        // Given a text file with Korean and Thai
        const text = utf8('한국어 and ภาษาไทย');

        // When the font needs are detected
        const needs = await detectFontNeeds(text, { scripts: ALL_SCRIPTS });

        // Then both scripts are reported
        assert.deepEqual([...needs.scripts].sort(), ['Hangul', 'Thai']);
    });

    it('only looks for the scripts it is asked about', async () => {
        // Given a text with Thai and Hangul
        const text = utf8('한국어 ภาษาไทย');

        // When only Thai is asked about
        const needs = await detectFontNeeds(text, { scripts: ['Thai'] });

        // Then only Thai is reported
        assert.deepEqual(needs.scripts, ['Thai']);
    });

    it('reports no script for Latin, Greek and Cyrillic text', async () => {
        // Given text in scripts the bundled fonts already cover
        const text = utf8('Hello, Ελληνικά, Русский, naïve café – “quotes” €5');

        // When the font needs are detected
        const needs = await detectFontNeeds(text, { scripts: ALL_SCRIPTS });

        // Then nothing is reported
        assert.deepEqual(needs.scripts, []);
    });

    it('reports nothing for a legacy binary file, whose bytes only look like text by accident', async () => {
        // Given an OLE2 file (DOC, XLS, PPT) holding Devanagari text as UTF-16,
        // whose signature alone would read as Hangul in UTF-16
        const doc = oleFileWithUtf16Text('नमस्ते दुनिया');

        // When the font needs are detected
        const needs = await detectFontNeeds(doc, { scripts: ALL_SCRIPTS });

        // Then no script is reported: guessing from raw bytes would flag nearly every file
        assert.deepEqual(needs.scripts, []);
        assert.deepEqual(needs.families, []);
    });

    it('reports nothing for images, even though some of their bytes form valid UTF-8', async () => {
        // Given real PNG and JPEG files
        const images = [fixture('matrix/sample.png'), fixture('matrix/sample.jpg')];

        // When the font needs are detected
        const results = await Promise.all(
            images.map((image) => detectFontNeeds(image, { scripts: ALL_SCRIPTS })));

        // Then nothing is reported, so converting a picture never downloads a font
        for (const needs of results) {
            assert.deepEqual(needs.scripts, []);
            assert.deepEqual(needs.families, []);
        }
    });

    it('ignores the east-Asian fallback fonts every Office theme lists by their native names', async () => {
        // Given a DOCX whose theme names Japanese and Korean fallback fonts, and whose text is Latin
        const docx = deflatedZip([
            {
                name: 'word/theme/theme1.xml',
                text: '<a:font script="Jpan" typeface="ＭＳ Ｐゴシック"/><a:font script="Hang" typeface="맑은 고딕"/>',
            },
            { name: 'word/document.xml', text: '<w:t>Plain Latin text</w:t>' },
        ]);

        // When the font needs are detected
        const needs = await detectFontNeeds(docx, { scripts: ALL_SCRIPTS });

        // Then no script is needed: font names are not text, so nothing is downloaded for them
        assert.deepEqual(needs.scripts, []);
    });

    it('finds no script in real PPTX and XLSX files whose themes name Japanese fonts', async () => {
        // Given documents made by python-pptx and openpyxl, with Latin text
        const files = [fixture('sample.pptx'), fixture('sample.xlsx'), fixture('sample.docx')];

        // When the font needs are detected
        const results = await Promise.all(
            files.map((file) => detectFontNeeds(file, { scripts: ALL_SCRIPTS })));

        // Then none of them needs a script font
        for (const needs of results) assert.deepEqual(needs.scripts, []);
    });

    it('reads Japanese text of an RTF file from its \\u escapes, not from its font table', async () => {
        // Given two RTF files whose font table names a Japanese font; only one has Japanese text
        const withText = utf8('{\\rtf1{\\fonttbl{\\f0\\fnil\\fcharset128 ＭＳ Ｐゴシック;}}'
            + '\\f0 \\u26085?\\u26412?}');
        const withoutText = utf8('{\\rtf1{\\fonttbl{\\f0\\fnil\\fcharset128 ＭＳ Ｐゴシック;}}\\f0 Hello}');

        // When the font needs are detected
        const found = await detectFontNeeds(withText, { scripts: ALL_SCRIPTS });
        const notFound = await detectFontNeeds(withoutText, { scripts: ALL_SCRIPTS });

        // Then only the file with Japanese text reports Han
        assert.deepEqual(found.scripts, ['Han']);
        assert.deepEqual(notFound.scripts, []);
    });

    it('reads only the text of a flat ODF file, not the CJK font names it declares', async () => {
        // Given two flat ODF files declaring a Japanese font; only one has Japanese text
        const declaration = '<office:font-face-decls><style:font-face style:name="ＭＳ ゴシック" '
            + 'svg:font-family="&apos;ＭＳ ゴシック&apos;"/></office:font-face-decls>';
        const latin = utf8('<?xml version="1.0"?><office:document>' + declaration
            + '<office:body><text:p>Hello</text:p></office:body></office:document>');
        const japanese = utf8('<?xml version="1.0"?><office:document>' + declaration
            + '<office:body><text:p>日本語</text:p></office:body></office:document>');

        // When the font needs are detected
        const fromLatin = await detectFontNeeds(latin, { scripts: ALL_SCRIPTS });
        const fromJapanese = await detectFontNeeds(japanese, { scripts: ALL_SCRIPTS });

        // Then only the file whose text is Japanese reports a script
        assert.deepEqual(fromLatin.scripts, []);
        assert.deepEqual(fromJapanese.scripts, ['Han']);
    });

    it('does not read attributes of an HTML file as text either', async () => {
        // Given an HTML file whose only Japanese is a font name in a style attribute
        const html = utf8('<html><body><p style="font-family: ＭＳ ゴシック">Hello</p></body></html>');

        // When the font needs are detected
        const needs = await detectFontNeeds(html, { scripts: ALL_SCRIPTS });

        // Then no script is needed
        assert.deepEqual(needs.scripts, []);
    });

    it('finds no script in the real flat ODF samples', async () => {
        // Given flat ODF files written by LibreOffice, which declare many CJK default fonts
        const files = [fixture('matrix/sample.fodt'), fixture('matrix/sample.fods'), fixture('matrix/sample.fodp')];

        // When the font needs are detected
        const results = await Promise.all(
            files.map((file) => detectFontNeeds(file, { scripts: ALL_SCRIPTS })));

        // Then none of them needs a script font
        for (const needs of results) assert.deepEqual(needs.scripts, []);
    });

    it('detects text in a UTF-16 file, such as Excel\'s "Unicode Text" export', async () => {
        // Given a tab-separated file in UTF-16 with a byte order mark
        const file = Uint8Array.from(Buffer.concat([
            Buffer.from([0xff, 0xfe]), Buffer.from('名前\t値\r\n', 'utf16le'),
        ]));

        // When the font needs are detected
        const needs = await detectFontNeeds(file, { scripts: ALL_SCRIPTS });

        // Then Han is reported
        assert.deepEqual(needs.scripts, ['Han']);
    });

    it('skips an XML part that is larger than the limit, instead of reading it all into memory', async () => {
        // Given a DOCX whose text part is 5,000 bytes of Japanese
        const docx = deflatedZip([{ name: 'word/document.xml', text: '<w:t>' + '日本語'.repeat(500) + '</w:t>' }]);

        // When the font needs are detected with a limit of 100 bytes per part
        const needs = await detectFontNeeds(docx, { scripts: ALL_SCRIPTS, maxPartBytes: 100 });

        // Then the part was not read, and nothing is reported
        assert.deepEqual(needs.scripts, []);
    });

    it('notices when Chinese text is marked as Traditional', async () => {
        // Given Han text in a DOCX that sets the east-Asian language to zh-TW
        const docx = deflatedZip([
            { name: 'word/document.xml', text: '<w:lang w:eastAsia="zh-TW"/><w:t>繁體中文</w:t>' },
        ]);
        const plain = deflatedZip([{ name: 'word/document.xml', text: '<w:t>简体中文</w:t>' }]);

        // When the font needs are detected
        const traditional = await detectFontNeeds(docx, { scripts: ALL_SCRIPTS });
        const simplified = await detectFontNeeds(plain, { scripts: ALL_SCRIPTS });

        // Then only the first is flagged as Traditional
        assert.equal(traditional.traditionalChinese, true);
        assert.equal(simplified.traditionalChinese, false);
    });

    it('detects Han text in a file with a UTF-8 byte order mark and CRLF lines', async () => {
        // Given a CSV exported by Excel
        const csv = utf8('﻿名前,値\r\n東京,1\r\n');

        // When the font needs are detected
        const needs = await detectFontNeeds(csv, { scripts: ALL_SCRIPTS });

        // Then Han is reported
        assert.deepEqual(needs.scripts, ['Han']);
    });
});

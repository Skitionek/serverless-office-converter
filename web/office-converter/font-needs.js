/* Finds out which fonts a document needs, before it is converted.
 *
 * Two kinds of need:
 *
 * - families: font names the document sets on its text (DOCX/XLSX/PPTX, ODF,
 *   HTML, RTF).  Plain text sets none.
 * - scripts: writing systems whose characters appear in the text, such as
 *   Han or Thai, which the bundled fonts cannot draw.  Which scripts to look
 *   for is up to the caller (they come from the font catalog).
 *
 * Scripts are only looked for in the text itself, because a false hit would
 * download a font of 5-10 MB:
 *
 * - Markup is not text.  Every Office theme lists a fallback font for East
 *   Asian scripts by its native name (typeface="ＭＳ Ｐゴシック"), and RTF names
 *   fonts in its font table, so those names must not count.  In the XML parts of
 *   a package, and in flat ODF, HTML and SVG, only the text between tags is
 *   read; in RTF only the \uN escapes.
 * - Only readable sources are scanned: the XML parts of a package, or a file
 *   that is valid UTF-8 from start to end.  Legacy binary files (DOC, XLS, PPT)
 *   and images are skipped, because raw bytes read as text produce CJK
 *   characters by accident.
 *
 * Families are cheap to get wrong: one that is not in the catalog is ignored later.
 */

import { readZip } from './zip.js';

// An XML part bigger than this (uncompressed) is not scanned.
const MAX_PART_BYTES = 256 * 1024 * 1024;

const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

// w:ascii / w:hAnsi / w:eastAsia / w:cs (WordprocessingML), typeface (DrawingML),
// face (HTML), font-name / font-family (ODF, SVG), with their -asian / -complex forms.
const FAMILY_ATTRIBUTE =
    /(?:\bw:ascii|\bw:hAnsi|\bw:eastAsia|\bw:cs|\btypeface|\bface|font-(?:name|family)(?:-asian|-complex)?)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const CSS_FONT_FAMILY = /font-family\s*:\s*([^;"}<]+)/g;
const SPREADSHEET_FONT_NAME = /<name val="([^"]*)"/g;
// {\f0\froman\fcharset0 Times New Roman;}
const RTF_FONT_TABLE_ENTRY = /\\f\d+(?:\\[a-z]+-?\d*)*\s+([^;\\{}]+);/g;

// zh-TW, zh-HK, zh-Hant, or ODF's language-asian="zh" country-asian="TW".
const TRADITIONAL_CHINESE =
    /zh[-_](?:TW|HK|MO|Hant)\b|language-asian="zh"[^>]*country-asian="(?:TW|HK|MO)"/i;

function unescapeXml(value) {
    return value.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

// "'Fira Sans', Roboto, sans-serif" -> ['Fira Sans', 'Roboto', 'sans-serif']
function splitFamilyList(value) {
    return unescapeXml(value)
        .split(',')
        .map((name) => name.trim().replace(/^["']|["']$/g, '').trim())
        .filter((name) => name.length > 0 && name.length <= 80);
}

function collectFamilies(text, families) {
    for (const match of text.matchAll(FAMILY_ATTRIBUTE)) {
        const value = match[1] !== undefined ? match[1] : match[2];
        splitFamilyList(value).forEach((name) => families.add(name));
    }
    for (const pattern of [CSS_FONT_FAMILY, SPREADSHEET_FONT_NAME, RTF_FONT_TABLE_ENTRY]) {
        for (const match of text.matchAll(pattern)) {
            splitFamilyList(match[1]).forEach((name) => families.add(name));
        }
    }
}

function startsWithOleSignature(bytes) {
    return OLE_SIGNATURE.every((byte, i) => bytes[i] === byte);
}

// Decodes UTF-8, or returns null when the bytes are not valid UTF-8 (so not text).
function decodeStrictUtf8(bytes) {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (notUtf8) {
        return null;
    }
}

// The text between the tags of an XML part.
function xmlText(xml) {
    return xml.replace(/<[^>]*>/g, ' ');
}

// RTF writes non-ASCII text as \u26085? (a signed UTF-16 unit, then a fallback character).
function rtfText(rtf) {
    return [...rtf.matchAll(/\\u(-?\d+)/g)]
        .map((match) => String.fromCharCode(Number(match[1]) & 0xffff))
        .join('');
}

// What a script can be found in, in a file that is not a package: markup (flat ODF, HTML,
// SVG) has its tags removed, RTF is read through its escapes, anything else is text already.
function scriptText(content) {
    if (content.startsWith('{\\rtf')) return rtfText(content);
    if (/^[﻿\s]*</.test(content)) return xmlText(content);
    return content;
}

// The file in pieces: one per XML part of a package, otherwise one.  `markup` is what a
// family name can be found in, `text` what a script can be found in.
async function* pieces(bytes) {
    const entries = await readZip(bytes);
    if (entries) {
        for (const entry of entries) {
            if (!entry.name.endsWith('.xml') || entry.size > MAX_PART_BYTES) continue;
            const xml = decodeStrictUtf8(await entry.data());
            if (xml !== null) yield { markup: xml, text: xmlText(xml) };
        }
        return;
    }
    if (startsWithOleSignature(bytes)) return;
    const content = decodeStrictUtf8(bytes);
    if (content === null) return;
    yield { markup: content, text: scriptText(content) };
}

/**
 * @param {Uint8Array} bytes The document.
 * @param {{scripts?: string[]}} [options] Unicode script names to look for (e.g. 'Han', 'Thai').
 * @returns {Promise<{families: string[], scripts: string[], traditionalChinese: boolean}>}
 *   scripts keeps the order it was asked for.
 */
export async function detectFontNeeds(bytes, { scripts = [] } = {}) {
    const patterns = scripts.map((name) => [name, new RegExp('\\p{Script=' + name + '}', 'u')]);
    const families = new Set();
    const foundScripts = new Set();
    let traditionalChinese = false;

    for await (const { markup, text } of pieces(bytes)) {
        collectFamilies(markup, families);
        for (const [name, pattern] of patterns) {
            if (!foundScripts.has(name) && pattern.test(text)) foundScripts.add(name);
        }
        if (!traditionalChinese && TRADITIONAL_CHINESE.test(markup)) traditionalChinese = true;
    }

    return {
        families: [...families],
        scripts: scripts.filter((name) => foundScripts.has(name)),
        traditionalChinese,
    };
}

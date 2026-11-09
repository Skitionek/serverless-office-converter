/* Wraps font files in a minimal, empty ODF text document, the "carrier".
 *
 * LibreOffice has no API to install a font while it runs, but it registers the
 * fonts embedded in a document it opens, for every other document, for as long
 * as that document stays open.  So to make a font available, the engine opens a
 * carrier (hidden) and never closes it; see lo-thread.js.
 *
 * The family name in the carrier is the name LibreOffice registers the font
 * under, whatever the file calls itself.  That is what lets a catalog alias
 * such as Georgia -> Gelasio work: Gelasio's file is registered as "Georgia".
 */

import { buildZip } from './zip.js';

const ODT_MIME_TYPE = 'application/vnd.oasis.opendocument.text';

const NAMESPACES = [
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
    'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
    'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"',
    'xmlns:xlink="http://www.w3.org/1999/xlink"',
].join(' ');

function escapeXmlAttribute(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * @param {string} family The name to register the fonts under.
 * @param {Uint8Array[]} fontFiles TrueType font files (static or variable) of that family.
 * @returns {Uint8Array} An .odt package.
 */
export function buildFontCarrier(family, fontFiles) {
    const encoder = new TextEncoder();
    const fontPaths = fontFiles.map((_, index) => 'Fonts/font' + (index + 1) + '.ttf');
    const name = escapeXmlAttribute(family);

    const sources = fontPaths.map((path) =>
        '<svg:font-face-uri xlink:href="' + path + '" xlink:type="simple">'
        + '<svg:font-face-format svg:string="truetype"/></svg:font-face-uri>').join('');
    const content = '<?xml version="1.0" encoding="UTF-8"?>'
        + '<office:document-content ' + NAMESPACES + ' office:version="1.3">'
        + '<office:font-face-decls>'
        + '<style:font-face style:name="' + name + '" svg:font-family="' + name + '">'
        + '<svg:font-face-src>' + sources + '</svg:font-face-src></style:font-face>'
        + '</office:font-face-decls>'
        + '<office:body><office:text><text:p/></office:text></office:body>'
        + '</office:document-content>';

    const fontEntries = fontPaths.map((path) =>
        '<manifest:file-entry manifest:full-path="' + path + '" '
        + 'manifest:media-type="application/x-font-ttf"/>').join('');
    const manifest = '<?xml version="1.0" encoding="UTF-8"?>'
        + '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" '
        + 'manifest:version="1.3">'
        + '<manifest:file-entry manifest:full-path="/" manifest:media-type="' + ODT_MIME_TYPE + '"/>'
        + '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>'
        + fontEntries
        + '</manifest:manifest>';

    return buildZip([
        { name: 'mimetype', data: encoder.encode(ODT_MIME_TYPE) },
        { name: 'META-INF/manifest.xml', data: encoder.encode(manifest) },
        { name: 'content.xml', data: encoder.encode(content) },
        ...fontFiles.map((data, index) => ({ name: fontPaths[index], data })),
    ]);
}

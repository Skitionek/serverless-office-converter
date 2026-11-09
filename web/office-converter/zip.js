/* Just enough of the zip format for on-demand fonts.
 *
 * - readZip() lists a zip (stored or deflate) and inflates entries with the
 *   browser's DecompressionStream, so font-needs.js can look inside DOCX, XLSX,
 *   PPTX and ODF files without a library.
 * - buildZip() writes an uncompressed zip, used to wrap fonts in a tiny ODF
 *   package (font-carrier.js).  Fonts are already compressed, and storing them
 *   keeps the package cheap to build.
 *
 * Not supported: ZIP64, encryption, multi-disk archives.
 */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_ENTRY = 0x02014b50;
const END_OF_DIRECTORY = 0x06054b50;
const END_OF_DIRECTORY_SIZE = 22;
const MAX_COMMENT_SIZE = 0xffff;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let value = n;
        for (let bit = 0; bit < 8; bit++) {
            value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        }
        table[n] = value >>> 0;
    }
    return table;
})();

export function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function findEndOfDirectory(view) {
    const lowest = Math.max(0, view.byteLength - END_OF_DIRECTORY_SIZE - MAX_COMMENT_SIZE);
    for (let at = view.byteLength - END_OF_DIRECTORY_SIZE; at >= lowest; at--) {
        if (view.getUint32(at, true) === END_OF_DIRECTORY) return at;
    }
    return -1;
}

// Inflates, giving up with a RangeError as soon as the output passes maxBytes: the size an
// entry declares is written by whoever made the file, so it cannot be trusted as a bound.
async function inflateRaw(compressed, maxBytes) {
    const reader = new Blob([compressed]).stream()
        .pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
            await reader.cancel();
            throw new RangeError('The zip entry is larger than ' + maxBytes + ' bytes.');
        }
        chunks.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
    }
    return out;
}

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<null | {name: string, method: number, size: number, data: (options?: {maxBytes?: number}) => Promise<Uint8Array>}[]>}
 *   null when the bytes are not a zip.
 */
export async function readZip(bytes) {
    if (bytes.length < END_OF_DIRECTORY_SIZE) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const endAt = findEndOfDirectory(view);
    if (endAt < 0) return null;

    const entryCount = view.getUint16(endAt + 10, true);
    let at = view.getUint32(endAt + 16, true);
    const names = new TextDecoder();
    const entries = [];
    for (let i = 0; i < entryCount; i++) {
        if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL_ENTRY) return null;
        const method = view.getUint16(at + 10, true);
        const compressedSize = view.getUint32(at + 20, true);
        const size = view.getUint32(at + 24, true);
        const nameLength = view.getUint16(at + 28, true);
        const extraLength = view.getUint16(at + 30, true);
        const commentLength = view.getUint16(at + 32, true);
        const localOffset = view.getUint32(at + 42, true);
        const name = names.decode(bytes.subarray(at + 46, at + 46 + nameLength));
        at += 46 + nameLength + extraLength + commentLength;

        entries.push({
            name,
            method,
            size,
            // maxBytes: throws a RangeError instead of returning more than that.
            async data({ maxBytes = Infinity } = {}) {
                if (view.getUint32(localOffset, true) !== LOCAL_HEADER) {
                    throw new Error('Damaged zip entry: ' + name);
                }
                // The local header repeats the name and extra field with lengths of its own.
                const dataStart = localOffset + 30
                    + view.getUint16(localOffset + 26, true)
                    + view.getUint16(localOffset + 28, true);
                const packed = bytes.subarray(dataStart, dataStart + compressedSize);
                if (method === METHOD_STORED) {
                    if (packed.length > maxBytes) throw new RangeError('The zip entry is larger than ' + maxBytes + ' bytes.');
                    return packed;
                }
                if (method === METHOD_DEFLATE) return inflateRaw(packed, maxBytes);
                throw new Error('Unsupported zip compression method ' + method + ': ' + name);
            },
        });
    }
    return entries;
}

/**
 * Writes an uncompressed zip with the entries in the given order.
 * @param {{name: string, data: Uint8Array}[]} entries
 * @returns {Uint8Array}
 */
export function buildZip(entries) {
    const encoder = new TextEncoder();
    const prepared = entries.map(({ name, data }) => ({
        nameBytes: encoder.encode(name), data, crc: crc32(data),
    }));

    const localSize = prepared.reduce((sum, e) => sum + 30 + e.nameBytes.length + e.data.length, 0);
    const centralSize = prepared.reduce((sum, e) => sum + 46 + e.nameBytes.length, 0);
    const out = new Uint8Array(localSize + centralSize + END_OF_DIRECTORY_SIZE);
    const view = new DataView(out.buffer);

    let at = 0;
    const offsets = [];
    for (const entry of prepared) {
        offsets.push(at);
        view.setUint32(at, LOCAL_HEADER, true);
        view.setUint16(at + 4, 20, true); // version needed
        view.setUint16(at + 8, METHOD_STORED, true);
        view.setUint32(at + 14, entry.crc, true);
        view.setUint32(at + 18, entry.data.length, true);
        view.setUint32(at + 22, entry.data.length, true);
        view.setUint16(at + 26, entry.nameBytes.length, true);
        out.set(entry.nameBytes, at + 30);
        out.set(entry.data, at + 30 + entry.nameBytes.length);
        at += 30 + entry.nameBytes.length + entry.data.length;
    }

    const centralStart = at;
    prepared.forEach((entry, i) => {
        view.setUint32(at, CENTRAL_ENTRY, true);
        view.setUint16(at + 4, 20, true); // version made by
        view.setUint16(at + 6, 20, true); // version needed
        view.setUint16(at + 10, METHOD_STORED, true);
        view.setUint32(at + 16, entry.crc, true);
        view.setUint32(at + 20, entry.data.length, true);
        view.setUint32(at + 24, entry.data.length, true);
        view.setUint16(at + 28, entry.nameBytes.length, true);
        view.setUint32(at + 42, offsets[i], true);
        out.set(entry.nameBytes, at + 46);
        at += 46 + entry.nameBytes.length;
    });

    view.setUint32(at, END_OF_DIRECTORY, true);
    view.setUint16(at + 8, prepared.length, true);
    view.setUint16(at + 10, prepared.length, true);
    view.setUint32(at + 12, centralSize, true);
    view.setUint32(at + 16, centralStart, true);
    return out;
}

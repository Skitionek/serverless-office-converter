// Test helpers shared by the unit tests.
import zlib from 'node:zlib';

export function utf8(text) {
    return new TextEncoder().encode(text);
}

/**
 * A real DEFLATE-compressed zip, written independently of the production zip
 * writer (which only stores), the way Word or LibreOffice would write one.
 * entries: [{ name, text }]
 */
export function deflatedZip(entries) {
    const parts = [];
    const central = [];
    let offset = 0;
    for (const { name, text } of entries) {
        const nameBytes = utf8(name);
        const raw = utf8(text);
        const packed = zlib.deflateRawSync(raw);
        const crc = zlib.crc32(raw);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(0, 6); // flags
        local.writeUInt16LE(8, 8); // method: deflate
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(packed.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        parts.push(local, nameBytes, packed);

        const entry = Buffer.alloc(46);
        entry.writeUInt32LE(0x02014b50, 0);
        entry.writeUInt16LE(20, 4); // version made by
        entry.writeUInt16LE(20, 6); // version needed
        entry.writeUInt16LE(8, 10); // method: deflate
        entry.writeUInt32LE(crc, 16);
        entry.writeUInt32LE(packed.length, 20);
        entry.writeUInt32LE(raw.length, 24);
        entry.writeUInt16LE(nameBytes.length, 28);
        entry.writeUInt32LE(offset, 42);
        central.push(entry, nameBytes);

        offset += local.length + nameBytes.length + packed.length;
    }
    const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    return new Uint8Array(Buffer.concat([...parts, ...central, end]));
}

// A legacy binary Office file starts with the OLE2 signature.
export function oleFileWithUtf16Text(text) {
    const signature = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const padding = new Uint8Array(504);
    const body = new Uint8Array(Buffer.from(text, 'utf16le'));
    return Uint8Array.from([...signature, ...padding, ...body]);
}

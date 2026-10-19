import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
    let value = index;

    for (let bit = 0; bit < 8; bit++) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }

    return value >>> 0;
});

function crc32(data: Buffer): number {
    let crc = 0xffffffff;

    for (const byte of data) {
        crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
    }

    return (crc ^ 0xffffffff) >>> 0;
}

const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const UTF8_NAMES = 0x0800;
const DEFLATE = 8;

interface Entry {
    name: Buffer;
    crc: number;
    size: number;
    data: Buffer;
    offset: number;
}

function localHeader(entry: Entry): Buffer {
    const header = Buffer.alloc(30);

    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(UTF8_NAMES, 6);
    header.writeUInt16LE(DEFLATE, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(entry.crc, 14);
    header.writeUInt32LE(entry.data.length, 18);
    header.writeUInt32LE(entry.size, 22);
    header.writeUInt16LE(entry.name.length, 26);
    header.writeUInt16LE(0, 28);

    return Buffer.concat([header, entry.name]);
}

function centralHeader(entry: Entry): Buffer {
    const header = Buffer.alloc(46);

    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(UTF8_NAMES, 8);
    header.writeUInt16LE(DEFLATE, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.data.length, 20);
    header.writeUInt32LE(entry.size, 24);
    header.writeUInt16LE(entry.name.length, 28);
    header.writeUInt32LE(entry.offset, 42);

    return Buffer.concat([header, entry.name]);
}

export function zip(files: Record<string, string>): Buffer {
    const parts: Buffer[] = [];
    const entries: Entry[] = [];
    let offset = 0;

    for (const [name, content] of Object.entries(files)) {
        const raw = Buffer.from(content, 'utf8');

        const entry = {
            name: Buffer.from(name, 'utf8'),
            crc: crc32(raw),
            size: raw.length,
            data: deflateRawSync(raw),
            offset,
        };

        const local = localHeader(entry);

        parts.push(local, entry.data);
        entries.push(entry);
        offset += local.length + entry.data.length;
    }

    const central = Buffer.concat(entries.map(centralHeader));
    const end = Buffer.alloc(22);

    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(central.length, 12);
    end.writeUInt32LE(offset, 16);

    return Buffer.concat([...parts, central, end]);
}

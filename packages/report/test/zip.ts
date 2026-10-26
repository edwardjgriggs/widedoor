import { crc32, inflateRawSync } from 'node:zlib';

/*
 * A tiny zip reader for the DOCX tests, independent of the JSZip the writer
 * uses: the end of central directory record, each central directory entry and
 * its local header, stored or deflated data. It throws on a bad signature, a
 * method other than those two, a size or CRC-32 that does not match, or an
 * entry that the central directory and the local header name differently.
 */

export interface ZipEntry {
  name: string;
  data: Buffer;
  /** The MS-DOS date and time fields, as written. */
  dosDate: number;
  dosTime: number;
}

export function readZip(zip: Uint8Array): ZipEntry[] {
  const buf = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  // The end of central directory record is 22 bytes plus a comment of up to 64 KiB.
  let eocd = -1;
  for (let at = buf.length - 22; at >= Math.max(0, buf.length - 22 - 0xffff); at--)
    if (buf.readUInt32LE(at) === 0x06054b50) {
      eocd = at;
      break;
    }
  if (eocd < 0) throw new Error('no end of central directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error(`bad central directory entry ${i}`);
    const method = buf.readUInt16LE(at + 10);
    const dosTime = buf.readUInt16LE(at + 12);
    const dosDate = buf.readUInt16LE(at + 14);
    const crc = buf.readUInt32LE(at + 16);
    const packed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extra = buf.readUInt16LE(at + 30);
    const comment = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extra + comment;

    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const localName = buf.readUInt16LE(local + 26);
    const localExtra = buf.readUInt16LE(local + 28);
    if (buf.toString('utf8', local + 30, local + 30 + localName) !== name)
      throw new Error(`local header names another file than ${name}`);
    const start = local + 30 + localName + localExtra;
    const raw = buf.subarray(start, start + packed);
    if (method !== 0 && method !== 8) throw new Error(`${name}: compression method ${method}`);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    if (data.length !== size) throw new Error(`${name}: size ${data.length}, expected ${size}`);
    if (crc32(data) !== crc) throw new Error(`${name}: CRC-32 does not match`);
    entries.push({ name, data, dosDate, dosTime });
  }
  return entries;
}

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

/*
 * Image embedding for the HTML report and the local viewer: screenshots from
 * the evidence folder, and the images reviewers attach to manual results
 * from widedoor-review/attachments. A path comes from a report or a review
 * file, which a hand edit or a pull request controls, so it is not trusted:
 * it is checked as text first (no drive letter, no leading separator, no ".."
 * segment), so nothing outside the folder is touched. A file is embedded only
 * when its real path (after symbolic links) is inside the real folder, it is
 * a regular file before and after opening (same device and inode, so it was
 * not swapped in between), it is under the size cap, the report's total is
 * under its cap, and the bytes read through that open handle are an image of
 * an allowed type. The type, and so the data: URI, comes from the bytes only,
 * never from the file name or the record.
 */

export interface ScreenshotLimits {
  /** Largest single image embedded, in bytes. Default 1 MiB (5 MiB for attachments). */
  maxBytes?: number;
  /** Most image bytes of this kind embedded in one report. Default 8 MiB (16 MiB for attachments). */
  maxTotalBytes?: number;
}

export type Screenshot =
  { ok: true; dataUri: string; bytes: number } | { ok: false; reason: string };

export type ImageType = 'image/png' | 'image/jpeg';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC-32 (ISO 3309, as PNG uses it). */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array, from: number, to: number): number {
  let c = 0xffffffff;
  for (let i = from; i < to; i++)
    c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A whole PNG: the signature, then chunks with valid lengths, letter types
 * and CRCs, IHDR first, at least one IDAT, and IEND as the last bytes. A PNG
 * header followed by anything else (HTML, a second file) fails.
 */
export function isPng(bytes: Buffer): boolean {
  if (bytes.length < PNG.length || !bytes.subarray(0, PNG.length).equals(PNG)) return false;
  let at = PNG.length;
  let first = true;
  let data = false;
  while (at + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    const end = at + 12 + length;
    if (length > 0x7fffffff || end > bytes.length || !/^[A-Za-z]{4}$/.test(type)) return false;
    if (crc32(bytes, at + 4, at + 8 + length) !== bytes.readUInt32BE(at + 8 + length)) return false;
    if (first && (type !== 'IHDR' || length !== 13)) return false;
    first = false;
    if (type === 'IDAT') data = true;
    if (type === 'IEND') return length === 0 && data && end === bytes.length;
    at = end;
  }
  return false;
}

/**
 * A whole baseline or progressive JPEG: SOI, then marker segments with valid
 * lengths, a frame header, at least one scan whose entropy-coded data is
 * walked byte by byte (stuffed zeros and restart markers), and EOI as the
 * last bytes.
 */
export function isJpeg(bytes: Buffer): boolean {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let at = 2;
  let frame = false;
  let scan = false;
  while (at < bytes.length) {
    if (bytes[at] !== 0xff) return false;
    // Fill bytes: any number of 0xFF before a marker.
    while (bytes[at] === 0xff && at < bytes.length) at++;
    const marker = bytes[at++];
    if (marker === undefined || marker === 0x00 || marker === 0xd8) return false;
    if (marker === 0xd9) return frame && scan && at === bytes.length;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (at + 2 > bytes.length) return false;
    const length = bytes.readUInt16BE(at);
    if (length < 2 || at + length > bytes.length) return false;
    // SOF0 to SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) frame = true;
    at += length;
    if (marker !== 0xda) continue;
    if (!frame) return false;
    scan = true;
    // Entropy-coded data runs to the next marker that is not a stuffed zero or a restart.
    for (;;) {
      if (at + 1 >= bytes.length) return false;
      if (bytes[at] === 0xff) {
        const next = bytes[at + 1] as number;
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) {
          at += next === 0xff ? 1 : 2;
          continue;
        }
        break;
      }
      at++;
    }
  }
  return false;
}

/** The type of a whole PNG or JPEG file, from its bytes only. */
export const imageType = (bytes: Buffer): ImageType | undefined =>
  isPng(bytes) ? 'image/png' : isJpeg(bytes) ? 'image/jpeg' : undefined;

// O_NONBLOCK keeps a FIFO from blocking the open on POSIX; Windows has no such flag.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

const isInside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/** A relative path with no drive, no leading separator, no NUL and no "." or ".." segment. */
const plainRelative = (path: string) =>
  path !== '' &&
  !path.includes('\0') &&
  !/^[A-Za-z]:/.test(path) &&
  !/^[\\/]/.test(path) &&
  !isAbsolute(path) &&
  path.split(/[\\/]/).every((part) => part !== '' && part !== '.' && part !== '..');

interface Kind {
  /** "evidence folder" or "attachments folder", in the reasons. */
  folder: string;
  /** The reason when the report's total for this kind is reached. */
  totalReason: string;
  /** The image type of the bytes, or undefined when they are not one this kind embeds. */
  typeOf: (bytes: Buffer) => ImageType | undefined;
  /** The reason when typeOf refuses the bytes. */
  notImage: string;
  maxBytes: number;
  maxTotalBytes: number;
}

/** Loads images from one folder for one report, keeping a running total against maxTotalBytes. */
class ContainedImages {
  private total = 0;
  private readonly root: string | undefined;
  private readonly maxBytes: number;
  private readonly maxTotalBytes: number;

  constructor(
    dir: string | undefined,
    limits: ScreenshotLimits,
    private readonly kind: Kind,
  ) {
    this.maxBytes = limits.maxBytes ?? kind.maxBytes;
    this.maxTotalBytes = limits.maxTotalBytes ?? kind.maxTotalBytes;
    try {
      this.root = dir === undefined ? undefined : realpathSync(dir);
    } catch {
      this.root = undefined;
    }
  }

  /** True once any image has been embedded (the CSP then allows data: images). */
  get embedded(): boolean {
    return this.total > 0;
  }

  load(path: string): Screenshot {
    // One reason for missing and outside, so a rendered report is not a file-existence oracle.
    const notInFolder = `the file is not in the ${this.kind.folder}`;
    const notPlain = `the path is not a plain path inside the ${this.kind.folder}`;
    if (this.root === undefined) return { ok: false, reason: `no ${this.kind.folder} was given` };
    if (!plainRelative(path)) return { ok: false, reason: notPlain };
    const candidate = resolve(this.root, path);
    if (!isInside(this.root, candidate)) return { ok: false, reason: notPlain };
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      return { ok: false, reason: notInFolder };
    }
    if (!isInside(this.root, real)) return { ok: false, reason: notInFolder };

    let fd: number | undefined;
    try {
      // bigint: inode numbers on Windows and some file systems do not fit a double exactly.
      const before = lstatSync(real, { bigint: true });
      if (!before.isFile()) return { ok: false, reason: 'the path is not a regular file' };
      fd = openSync(real, OPEN_FLAGS);
      const stat = fstatSync(fd, { bigint: true });
      const now = statSync(real, { bigint: true });
      if (
        !stat.isFile() ||
        stat.dev !== before.dev ||
        stat.ino !== before.ino ||
        stat.dev !== now.dev ||
        stat.ino !== now.ino ||
        realpathSync(real) !== real
      )
        return { ok: false, reason: 'the file changed while it was being read' };
      const size = Number(stat.size);
      if (size > this.maxBytes) return { ok: false, reason: 'the file is over the size limit' };
      if (this.total + size > this.maxTotalBytes)
        return { ok: false, reason: this.kind.totalReason };
      const bytes = Buffer.alloc(size);
      let read = 0;
      while (read < bytes.length) {
        const n = readSync(fd, bytes, read, bytes.length - read, read);
        if (n === 0) break;
        read += n;
      }
      // The bytes read through the open handle decide, never the name.
      const type = read === bytes.length ? this.kind.typeOf(bytes) : undefined;
      if (type === undefined) return { ok: false, reason: this.kind.notImage };
      this.total += read;
      return { ok: true, dataUri: `data:${type};base64,${bytes.toString('base64')}`, bytes: read };
    } catch {
      return { ok: false, reason: 'the file could not be read' };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}

/**
 * Screenshots from the evidence folder: whole PNG files only (isPng). The
 * scan writes them, but the report that names them may be hand-edited.
 */
export class ScreenshotLoader extends ContainedImages {
  constructor(evidenceDir: string | undefined, limits: ScreenshotLimits = {}) {
    super(evidenceDir, limits, {
      folder: 'evidence folder',
      totalReason: 'the report reached its screenshot size limit',
      typeOf: (bytes) => (isPng(bytes) ? 'image/png' : undefined),
      notImage: 'the file is not a PNG image',
      maxBytes: 1024 * 1024,
      maxTotalBytes: 8 * 1024 * 1024,
    });
  }
}

/** The path a review record names for an attachment: attachments/<name>.png, .jpg or .jpeg. */
const ATTACHMENT_PATH = /^attachments\/([A-Za-z0-9_-]{1,100}\.(?:png|jpg|jpeg))$/;

/**
 * Why a folder Widedoor reads review files from cannot be used: a link or
 * junction (which realpath would follow), or not a folder. Undefined when it
 * is a real folder or does not exist (then nothing is found in it).
 */
function linkedFolder(path: string): string | undefined {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    return undefined;
  }
  if (info.isSymbolicLink())
    return `${basename(path)}/ is a symbolic link or junction; Widedoor reads only a real folder here`;
  return info.isDirectory() ? undefined : `${basename(path)}/ is not a folder`;
}

/**
 * Attachments of manual review records, from widedoor-review/attachments:
 * whole PNG or JPEG files only (isPng, isJpeg), whatever their names say.
 * Like loadReviews, it refuses a widedoor-review/ or attachments/ that is a
 * symbolic link or junction rather than following it.
 */
export class AttachmentLoader extends ContainedImages {
  private readonly refused: string | undefined;

  constructor(attachmentsDir: string | undefined, limits: ScreenshotLimits = {}) {
    const refused =
      attachmentsDir === undefined
        ? undefined
        : (linkedFolder(dirname(attachmentsDir)) ?? linkedFolder(attachmentsDir));
    super(refused === undefined ? attachmentsDir : undefined, limits, {
      folder: 'attachments folder',
      totalReason: 'the report reached its attachment size limit',
      typeOf: imageType,
      notImage: 'the file is not a whole PNG or JPEG image',
      maxBytes: 5 * 1024 * 1024,
      maxTotalBytes: 16 * 1024 * 1024,
    });
    this.refused = refused;
  }

  /** Loads an attachment by the path its record names (attachments/<name>). */
  override load(path: string): Screenshot {
    const name = ATTACHMENT_PATH.exec(path)?.[1];
    if (name === undefined)
      return { ok: false, reason: 'the path is not attachments/<name>.png, .jpg or .jpeg' };
    if (this.refused !== undefined) return { ok: false, reason: this.refused };
    return super.load(name);
  }
}

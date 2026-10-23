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
import { isAbsolute, relative, resolve } from 'node:path';

/*
 * Screenshot embedding for the HTML report. A finding's evidence.screenshot is
 * a path relative to the evidence folder, but the report must not trust it: a
 * hand-edited JSON report or a stray symbolic link could point anywhere. The
 * path is checked as text first (no drive letter, no leading separator, no ".."
 * segment), so nothing outside the folder is touched. The file is embedded
 * only when its real path (after symbolic links) is inside the real evidence
 * folder, it is a regular file before and after opening (same device and
 * inode, so it was not swapped in between), it is under the size cap, the
 * report's total is under its cap, and it starts with the PNG signature.
 */

export interface ScreenshotLimits {
  /** Largest single screenshot embedded, in bytes. Default 1 MiB. */
  maxBytes?: number;
  /** Most screenshot bytes embedded in one report. Default 8 MiB. */
  maxTotalBytes?: number;
}

export type Screenshot =
  { ok: true; dataUri: string; bytes: number } | { ok: false; reason: string };

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// One reason for missing and outside, so a rendered report is not a file-existence oracle.
const NOT_IN_FOLDER = 'the file is not in the evidence folder';
const NOT_PLAIN = 'the path is not a plain path inside the evidence folder';

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

/** Loads screenshots for one report, keeping a running total against maxTotalBytes. */
export class ScreenshotLoader {
  private total = 0;
  private readonly root: string | undefined;
  private readonly maxBytes: number;
  private readonly maxTotalBytes: number;

  constructor(evidenceDir: string | undefined, limits: ScreenshotLimits = {}) {
    this.maxBytes = limits.maxBytes ?? 1024 * 1024;
    this.maxTotalBytes = limits.maxTotalBytes ?? 8 * 1024 * 1024;
    try {
      this.root = evidenceDir === undefined ? undefined : realpathSync(evidenceDir);
    } catch {
      this.root = undefined;
    }
  }

  /** True once any screenshot has been embedded (the CSP then allows data: images). */
  get embedded(): boolean {
    return this.total > 0;
  }

  load(path: string): Screenshot {
    if (this.root === undefined) return { ok: false, reason: 'no evidence folder was given' };
    if (!plainRelative(path)) return { ok: false, reason: NOT_PLAIN };
    const candidate = resolve(this.root, path);
    if (!isInside(this.root, candidate)) return { ok: false, reason: NOT_PLAIN };
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      return { ok: false, reason: NOT_IN_FOLDER };
    }
    if (!isInside(this.root, real)) return { ok: false, reason: NOT_IN_FOLDER };

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
        return { ok: false, reason: 'the report reached its screenshot size limit' };
      const bytes = Buffer.alloc(size);
      let read = 0;
      while (read < bytes.length) {
        const n = readSync(fd, bytes, read, bytes.length - read, read);
        if (n === 0) break;
        read += n;
      }
      if (read !== bytes.length || !bytes.subarray(0, PNG.length).equals(PNG))
        return { ok: false, reason: 'the file is not a PNG image' };
      this.total += read;
      return {
        ok: true,
        dataUri: `data:image/png;base64,${bytes.toString('base64')}`,
        bytes: read,
      };
    } catch {
      return { ok: false, reason: 'the file could not be read' };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}

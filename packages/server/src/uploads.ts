import { randomBytes } from 'node:crypto';
import { lstat, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_ATTACHMENT_BYTES } from '@widedoor/core';
import { imageType } from '@widedoor/report';
import { hostTag, isAlive } from './lifecycle.js';

/*
 * Files the page sends before it names them in a scan request (PDFs) or a
 * review (images). Each upload is checked by its bytes (a PDF header; a
 * whole PNG or JPEG, as the viewer's attachment loader reads them), gets a random 128-bit
 * id (the only name a request can use) and is written exclusively, mode
 * 0600, into one private folder from mkdtemp, removed when the server stops.
 * A PDF may carry a plain file name, which a scan records it under.
 *
 * The held cap is charged before any await: a request reserves its bytes
 * when its headers arrive (reserve), and add settles the reservation to the
 * real size, so uploads in flight together can never pass the cap. The
 * folder is named after this host and process, so a later server can remove
 * the folder of one that was killed (sweepStaleUploads), as the container
 * sweep does for containers. An upload no scan or review has used within
 * UNUSED_UPLOAD_MS is deleted and its bytes freed; a running scan or a
 * review in progress claims its uploads, so they never expire in use.
 */

export const UPLOAD_KINDS = ['pdf', 'image'] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

/** Largest PDF upload. */
export const MAX_PDF_UPLOAD_BYTES = 25 * 1024 * 1024;
/** Uploads held at once, in bytes, across every kind. */
export const MAX_HELD_UPLOAD_BYTES = 500 * 1024 * 1024;

/** The largest upload of a kind: a PDF, or a review attachment. */
export const maxUploadBytes = (kind: UploadKind): number =>
  kind === 'pdf' ? MAX_PDF_UPLOAD_BYTES : MAX_ATTACHMENT_BYTES;

/** A plain PDF file name: no folder, no device name, no leading dot. */
const PDF_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.pdf$/i;
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
export const UPLOAD_ID = /^[0-9a-f]{32}$/;

export const isPdfName = (name: string): boolean => PDF_NAME.test(name) && !DEVICE_NAME.test(name);

/** An upload refused; status is the HTTP status that says why. */
export class UploadError extends Error {
  constructor(
    readonly status: 400 | 413,
    message: string,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/** Bytes held back against the cap for an upload in flight; release is idempotent and returns what it freed. */
export interface Reservation {
  readonly bytes: number;
  release(): number;
}

const FOLDER = 'widedoor-uploads-';
const OWNED_FOLDER = /^widedoor-uploads-h([0-9a-f]{8})-p(\d+)-/;

/** The uploads folder name prefix for one server: host tag and process id (mkdtemp appends a random suffix). */
export const uploadsPrefix = (pid = process.pid, host = hostTag()): string =>
  `${FOLDER}h${host}-p${pid}-`;

/**
 * Removes the uploads folders of servers on this host that no longer run
 * (killed hard, so their own cleanup never ran). Only real folders (never a
 * link), owned by this user where the system says so, whose name carries
 * this host's tag and a dead process id. Returns how many; never throws.
 */
export async function sweepStaleUploads(
  parent: string = tmpdir(),
  host: string = hostTag(),
  alive: (pid: number) => boolean = isAlive,
): Promise<number> {
  let removed = 0;
  let names: string[];
  try {
    names = await readdir(parent);
  } catch {
    return 0;
  }
  const uid = process.getuid?.();
  for (const name of names) {
    const owned = OWNED_FOLDER.exec(name);
    if (!owned || owned[1] !== host || alive(Number(owned[2]))) continue;
    const path = join(parent, name);
    try {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      if (uid !== undefined && stat.uid !== uid) continue;
      // rm never follows a link inside the folder: it removes the link itself.
      await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      removed++;
    } catch {
      // Gone already, or not ours to remove.
    }
  }
  return removed;
}

/** How long an upload no scan or review uses is held before it is deleted. */
export const UNUSED_UPLOAD_MS = 15 * 60 * 1000;

/** Starts a timer and returns its cancel; injectable for tests. */
export type UploadTimer = (fire: () => void, ms: number) => () => void;

const realTimer: UploadTimer = (fire, ms) => {
  const t = setTimeout(fire, ms);
  // An expiry timer never keeps the process alive.
  t.unref();
  return () => clearTimeout(t);
};

export interface Upload {
  id: string;
  kind: UploadKind;
  /** The file on disk: <id>.pdf, .png or .jpg in the uploads folder. */
  path: string;
  bytes: number;
  /** PDFs: the name a scan records the file under (the given one, else upload-<id>.pdf). */
  name?: string;
}

export class Uploads {
  private readonly held = new Map<string, Upload>();
  /** The expiry of each upload not claimed by a scan or a review. */
  private readonly expiries = new Map<string, () => void>();
  private total = 0;
  private reserved = 0;

  private constructor(
    readonly dir: string,
    private readonly maxHeld: number,
    private readonly timer: UploadTimer,
  ) {}

  /**
   * The uploads folder of one server, after removing those of dead servers.
   * maxHeldBytes and timer are for tests; MAX_HELD_UPLOAD_BYTES and real timers otherwise.
   */
  static async create(
    maxHeldBytes = MAX_HELD_UPLOAD_BYTES,
    timer: UploadTimer = realTimer,
  ): Promise<Uploads> {
    await sweepStaleUploads();
    return new Uploads(await mkdtemp(join(tmpdir(), uploadsPrefix())), maxHeldBytes, timer);
  }

  /** Starts (again) the expiry of uploads still held. */
  private expireLater(ids: readonly string[]): void {
    for (const id of ids) {
      if (!this.held.has(id)) continue;
      this.expiries.get(id)?.();
      this.expiries.set(
        id,
        this.timer(() => void this.delete([id]), UNUSED_UPLOAD_MS),
      );
    }
  }

  /** Marks uploads as in use by a scan or a review: they do not expire until unclaimed. */
  claim(ids: readonly string[]): void {
    for (const id of ids) {
      this.expiries.get(id)?.();
      this.expiries.delete(id);
    }
  }

  /** Uploads a scan or a review did not use up (a cancelled scan, a refused review) expire again. */
  unclaim(ids: readonly string[]): void {
    this.expireLater(ids);
  }

  /** Bytes that may still be uploaded before the hold cap is reached (held and reserved bytes count). */
  get room(): number {
    return this.maxHeld - this.total - this.reserved;
  }

  /** Holds bytes back for an upload in flight, synchronously; undefined when they do not fit. */
  reserve(bytes: number): Reservation | undefined {
    if (bytes > this.room) return undefined;
    this.reserved += bytes;
    let held = true;
    return {
      bytes,
      release: () => {
        if (!held) return 0;
        held = false;
        this.reserved -= bytes;
        return bytes;
      },
    };
  }

  /** Checks and stores one upload, settling its reservation to the real size. Throws UploadError. */
  async add(
    kind: UploadKind,
    body: Uint8Array,
    name?: string,
    reservation?: Reservation,
  ): Promise<Upload> {
    if (body.length > maxUploadBytes(kind))
      throw new UploadError(413, `the ${kind} is over ${maxUploadBytes(kind) / 1024 / 1024} MiB`);
    let ext: string;
    if (kind === 'pdf') {
      if (Buffer.from(body.subarray(0, 5)).toString('latin1') !== '%PDF-')
        throw new UploadError(400, 'the file is not a PDF (it does not start with %PDF-)');
      if (name !== undefined && !isPdfName(name))
        throw new UploadError(
          400,
          'name must be a plain PDF file name (letters, digits, dots, dashes and underscores, ending in .pdf)',
        );
      ext = 'pdf';
    } else {
      const type = imageType(Buffer.from(body.buffer, body.byteOffset, body.length));
      if (type === undefined)
        throw new UploadError(400, 'the file is not a whole PNG or JPEG image');
      if (name !== undefined) throw new UploadError(400, 'only a PDF upload takes a name');
      ext = type === 'image/png' ? 'png' : 'jpg';
    }
    // Charged before the write: no other upload can take these bytes meanwhile.
    reservation?.release();
    if (body.length > this.room)
      throw new UploadError(413, 'too many uploads are held; record or scan them first');
    this.total += body.length;
    const id = randomBytes(16).toString('hex');
    const path = join(this.dir, `${id}.${ext}`);
    try {
      await writeFile(path, body, { flag: 'wx', mode: 0o600 });
    } catch (e) {
      this.total -= body.length;
      throw e;
    }
    const upload: Upload = {
      id,
      kind,
      path,
      bytes: body.length,
      ...(kind === 'pdf' ? { name: name ?? `upload-${id.slice(0, 8)}.pdf` } : {}),
    };
    this.held.set(id, upload);
    this.expireLater([id]);
    return upload;
  }

  get(id: string, kind: UploadKind): Upload | undefined {
    const upload = this.held.get(id);
    return upload?.kind === kind ? upload : undefined;
  }

  /** Deletes uploads that were used (by a finished scan or a recorded review) or expired. */
  async delete(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const upload = this.held.get(id);
      if (!upload) continue;
      this.claim([id]);
      this.held.delete(id);
      this.total -= upload.bytes;
      await rm(upload.path, { force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
    }
  }

  /** Removes the folder and every upload in it. */
  async close(): Promise<void> {
    this.claim([...this.held.keys()]);
    this.held.clear();
    this.total = 0;
    // Windows can hold a just-closed file for a moment (antivirus, indexer).
    await rm(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
      () => undefined,
    );
  }
}

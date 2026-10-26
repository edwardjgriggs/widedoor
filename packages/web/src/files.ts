import { randomBytes } from 'node:crypto';
import { lstat, mkdtemp, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PdfFetchError,
  createFetcher,
  fetchPdf,
  type Fetcher,
  type PdfFetchErrorCode,
  type PdfFetchOptions,
} from './fetch.js';
import { normalizeUrl } from './url.js';

/**
 * Writes dir/name without following a link that sits at that name: the bytes
 * go to a new temp file in the same folder (opened with wx, so it cannot be a
 * planted file or link), which is then renamed over the name. A rename replaces
 * a symbolic link or junction at the target instead of writing through it.
 * The file is always created fresh, so mode always applies.
 */
export async function writeFileReplacing(
  dir: string,
  name: string,
  data: string | Uint8Array,
  mode = 0o644,
): Promise<void> {
  const target = join(dir, name);
  const temp = join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  const file = await open(temp, 'wx', mode);
  try {
    await file.writeFile(data);
  } catch (e) {
    await file.close().catch(() => undefined);
    await rm(temp, { force: true });
    throw e;
  }
  await file.close();
  try {
    // A directory (or a junction, which reads as a link) at the name is not replaced silently.
    const existing = await lstat(target).catch(() => undefined);
    if (existing?.isDirectory()) throw new Error(`${name} is a folder`);
    await rename(temp, target);
  } catch (e) {
    await rm(temp, { force: true });
    throw e;
  }
}

/**
 * A PDF URL, fetched only when the scan is ready for it, so at most one file
 * per scan worker sits on disk at a time.
 */
export interface FetchedPdfSource {
  /** The URL as given. */
  url: string;
  /**
   * Streams the PDF into a temp file. Resolves with its path and its asset
   * uri (the final URL after redirects, normalized as pages are), or
   * undefined when the fetch failed (listed in failed).
   */
  load(): Promise<{ path: string; uri: string } | undefined>;
  /** Deletes the temp file once it is scanned. */
  release(): Promise<void>;
}

export interface PdfFetchFailure {
  url: string;
  code: PdfFetchErrorCode;
  /** Safe to print. */
  message: string;
}

export interface FetchPdfsOptions extends PdfFetchOptions {
  /** Default: createFetcher(), which keeps every redirect on the origin of the URL. */
  fetcher?: Fetcher;
  /** Told the temp folder, so an interrupt that exits before the finally can still remove it. */
  onTempDir?: (dir: string) => void;
}

/** Writes all of chunk at the file's current end. */
async function writeAll(file: FileHandle, chunk: Uint8Array): Promise<void> {
  for (let at = 0; at < chunk.length;) {
    const { bytesWritten } = await file.write(chunk, at, chunk.length - at);
    at += bytesWritten;
  }
}

/**
 * Calls use with one source per URL (load streams it with fetchPdf into a
 * private temp folder) and returns its result with the URLs whose fetch
 * failed, in URL order. The folder is removed afterwards, also when use
 * throws. It comes from mkdtemp (mode 0700 on POSIX); file names are
 * counters, never taken from the URL, and each is created exclusively (wx, 0600).
 */
export async function withFetchedPdfs<T>(
  urls: readonly string[],
  options: FetchPdfsOptions,
  use: (sources: FetchedPdfSource[]) => Promise<T>,
): Promise<{ result: T; failed: PdfFetchFailure[] }> {
  const fetcher = options.fetcher ?? createFetcher();
  const dir = await mkdtemp(join(tmpdir(), 'widedoor-pdf-'));
  options.onTempDir?.(dir);
  const failures: (PdfFetchFailure | undefined)[] = new Array(urls.length);
  const sources = urls.map((url, i): FetchedPdfSource => {
    const path = join(dir, `${i}.pdf`);
    return {
      url,
      load: async () => {
        try {
          const file = await open(path, 'wx', 0o600);
          let final: string;
          try {
            final = (await fetchPdf(fetcher, url, (chunk) => writeAll(file, chunk), options)).url;
          } finally {
            await file.close();
          }
          return { path, uri: normalizeUrl(final) };
        } catch (e) {
          await rm(path, { force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
          failures[i] =
            e instanceof PdfFetchError
              ? { url, code: e.code, message: e.message }
              : // Fixed text: fs messages carry the temp path.
                {
                  url,
                  code: 'pdf-fetch-failed',
                  message: 'the PDF could not be saved for the scan',
                };
          return undefined;
        }
      },
      release: () => rm(path, { force: true, maxRetries: 5, retryDelay: 200 }),
    };
  });
  try {
    const result = await use(sources);
    return { result, failed: failures.filter((f) => f !== undefined) };
  } finally {
    // Windows can hold a just-closed file for a moment (antivirus, indexer).
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

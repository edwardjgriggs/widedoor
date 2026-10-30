import { lstatSync } from 'node:fs';
import { chmod, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { writeFileReplacing } from '@widedoor/web';
import { FORMATS, type Format } from './settings.js';

/*
 * The report folder may sit in a checkout a pull request controls, so nothing
 * in it is trusted: no component of the --out path below the working folder
 * or the config folder, nor evidence/, nor any report name may be a symbolic
 * link or junction (refused, exit 2), and every file is written fresh through
 * a temp file and a rename, which replaces a link instead of writing through it.
 *
 * Widedoor clears only a folder it owns: one that holds its marker file. A
 * missing or empty folder gets the marker; a non-empty folder without it is
 * refused and nothing in it is touched.
 */

const EXTENSION: Record<Format, string> = {
  html: 'html',
  json: 'json',
  sarif: 'sarif',
  junit: 'junit.xml',
  openacr: 'openacr.yaml',
  'vpat-html': 'vpat.html',
  'vpat-docx': 'vpat.docx',
};
/** Marks a folder as Widedoor's own report folder, which each run clears. */
export const MARKER = '.widedoor-report';
const MARKER_TEXT =
  'This folder holds Widedoor reports. Each scan clears the report files and evidence/ here.\n';
/** Temp files left by an interrupted write (see writeFileReplacing); report.vpat.docx has two dots. */
const STALE_TEMP = /^\.(?:report\.[\w.]+|ai-suggestions\.(?:json|html))\.[0-9a-f]{12}\.tmp$/;
/** The same, for the sidecars only: writeSidecars sweeps these and leaves a report's alone. */
const STALE_SIDECAR_TEMP = /^\.ai-suggestions\.(?:json|html)\.[0-9a-f]{12}\.tmp$/;

/**
 * Beside the reports of a signed-in scan (storage state): widedoor suggest and widedoor ui read
 * it on every platform, so AI stays off for those reports without ai.allowSignedIn. A report
 * copied without it is not known as signed-in (off Windows its owner-only mode still is).
 */
export const SIGNED_IN_MARKER = '.widedoor-signed-in';
const SIGNED_IN_TEXT =
  'These reports come from a signed-in scan: their snippets can hold personal data. AI fix suggestions need ai.allowSignedIn for them.\n';

/** Whether the folder of a report holds the signed-in marker (a plain file, not a link). */
export function signedInMarked(reportFile: string): boolean {
  try {
    return lstatSync(join(dirname(reportFile), SIGNED_IN_MARKER)).isFile();
  } catch {
    return false;
  }
}

/** Writes the signed-in marker into a report folder prepareOut made ready. */
export async function writeSignedInMarker(out: string) {
  await checkFileName(join(out, SIGNED_IN_MARKER));
  await writeFileReplacing(out, SIGNED_IN_MARKER, SIGNED_IN_TEXT, 0o600);
}

/** The AI suggestions sidecar files (@widedoor/ai writes them through the CLI; the server never loads it). */
export const AI_SIDECARS = ['ai-suggestions.json', 'ai-suggestions.html'] as const;
export type AiSidecar = (typeof AI_SIDECARS)[number];

export const reportName = (format: Format) => `report.${EXTENSION[format]}`;
export const reportPath = (out: string, format: Format) => join(out, reportName(format));
export const evidencePath = (out: string) => join(out, 'evidence');

/** The report folder cannot be used safely; exit code 2. */
export class OutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutputError';
  }
}

const statOf = (path: string) =>
  lstat(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return undefined;
    throw new OutputError(`${path} cannot be read (${e.code ?? 'error'})`);
  });

const linkRefused = (path: string) =>
  new OutputError(`${path} is a symbolic link or junction; Widedoor does not write through links`);

/**
 * Refuses a link at any existing component of out that lies below one of the
 * roots (the working folder, the config folder), out itself included. A path
 * outside every root is one the user named in full; only out itself is checked.
 */
async function checkComponents(out: string, roots: readonly string[]) {
  const root = roots
    .map((r) => resolve(r))
    .filter((r) => {
      const rel = relative(r, out);
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    })
    .sort((a, b) => a.length - b.length)[0];
  const parts = root === undefined ? [] : relative(root, out).split(sep);
  let path = root ?? out;
  for (const part of root === undefined ? [''] : parts) {
    path = part === '' ? path : join(path, part);
    const stat = await statOf(path);
    if (stat === undefined) return;
    if (stat.isSymbolicLink()) throw linkRefused(path);
  }
}

/** Refuses a link or folder at a file name the run will write. */
async function checkFileName(path: string) {
  const stat = await statOf(path);
  if (stat?.isSymbolicLink()) throw linkRefused(path);
  if (stat?.isDirectory()) throw new OutputError(`${path} is a folder, not a report file`);
}

async function checkFolder(path: string) {
  const stat = await statOf(path);
  if (stat?.isSymbolicLink()) throw linkRefused(path);
  if (stat !== undefined && !stat.isDirectory()) throw new OutputError(`${path} is not a folder`);
  return stat !== undefined;
}

const mkdirOrFail = (path: string, recursive: boolean, mode: number | undefined) =>
  mkdir(path, { recursive, ...(mode !== undefined ? { mode } : {}) }).catch(
    (e: NodeJS.ErrnoException) => {
      if (e.code === 'EEXIST') return undefined;
      throw new OutputError(`${path} cannot be created (${e.code ?? 'error'})`);
    },
  );

/**
 * Prepares the report folder before a scan and throws OutputError when it
 * cannot be used. In a folder that carries the marker, the report files of
 * every format, the contents of evidence/ and stale temp files are removed,
 * so the folder never mixes two runs or keeps a report from a failed run.
 */
export async function prepareOut(out: string, restricted: boolean, roots: readonly string[]) {
  const mode = restricted ? 0o700 : undefined;
  await checkComponents(out, roots);
  const exists = await checkFolder(out);
  const evidence = evidencePath(out);
  if (exists) {
    await checkFileName(join(out, MARKER));
    for (const format of FORMATS) await checkFileName(reportPath(out, format));
    for (const name of AI_SIDECARS) await checkFileName(join(out, name));
    await checkFileName(join(out, SIGNED_IN_MARKER));
    await checkFolder(evidence);
    const names = await readdir(out);
    if (!names.includes(MARKER)) {
      if (names.length > 0)
        throw new OutputError(
          `${out} is not empty and has no ${MARKER} marker, so Widedoor will not clear it; ` +
            'choose a new or empty folder with --out',
        );
    } else {
      for (const format of FORMATS) await rm(reportPath(out, format), { force: true });
      // A sidecar from an earlier run would sit beside a report it does not describe.
      for (const name of AI_SIDECARS) await rm(join(out, name), { force: true });
      // Each run says afresh whether it was signed in.
      await rm(join(out, SIGNED_IN_MARKER), { force: true });
      for (const name of names)
        if (STALE_TEMP.test(name) && (await statOf(join(out, name)))?.isFile())
          await rm(join(out, name), { force: true });
      if (names.includes('evidence')) {
        for (const name of await readdir(evidence)) {
          const stat = await statOf(join(evidence, name));
          if (!stat?.isFile())
            throw new OutputError(
              `${join(evidence, name)} is not a file Widedoor wrote; clear evidence/ by hand`,
            );
          await rm(join(evidence, name), { force: true });
        }
      }
    }
  } else {
    await mkdirOrFail(out, true, mode);
    // A link created in the meantime, or a parent created through one, is caught here.
    await checkComponents(out, roots);
    if (!(await checkFolder(out))) throw new OutputError(`${out} cannot be created`);
  }
  if (!(await statOf(join(out, MARKER))))
    await writeFileReplacing(out, MARKER, MARKER_TEXT, restricted ? 0o600 : 0o644);
  await mkdirOrFail(evidence, false, mode);
  await checkFolder(evidence);
  if (mode !== undefined) {
    await chmod(out, mode).catch(() => undefined);
    await chmod(evidence, mode).catch(() => undefined);
  }
}

/** Writes one report file without following links; checks the folder again first. */
export async function writeReport(
  out: string,
  format: Format,
  data: string | Uint8Array,
  restricted: boolean,
) {
  if (!(await checkFolder(out))) throw new OutputError(`${out} is gone`);
  await checkFileName(reportPath(out, format));
  await writeFileReplacing(out, reportName(format), data, restricted ? 0o600 : 0o644);
}

/**
 * Writes the two AI suggestions sidecars into a report folder without
 * following links: the folder is created when missing (its components
 * checked against the roots, as prepareOut does), and a report beside them
 * is left as it is. A folder it creates gets the marker. In a folder with
 * the marker, stale sidecar temps and both old sidecars are removed first, so
 * an interrupted write leaves at most a new JSON without its HTML, never a
 * new file beside an old one; a folder without it (not Widedoor's) loses
 * nothing but the two names it writes.
 */
export async function writeSidecars(
  out: string,
  files: Record<AiSidecar, string>,
  restricted: boolean,
  roots: readonly string[],
) {
  await checkSidecarOut(out, roots);
  const mode = restricted ? 0o600 : 0o644;
  if (!(await checkFolder(out))) {
    await mkdirOrFail(out, true, restricted ? 0o700 : undefined);
    await checkComponents(out, roots);
    if (!(await checkFolder(out))) throw new OutputError(`${out} cannot be created`);
    await writeFileReplacing(out, MARKER, MARKER_TEXT, mode);
  }
  if ((await statOf(join(out, MARKER)))?.isFile()) {
    for (const name of await readdir(out))
      if (STALE_SIDECAR_TEMP.test(name) && (await statOf(join(out, name)))?.isFile())
        await rm(join(out, name), { force: true });
    for (const name of AI_SIDECARS) await rm(join(out, name), { force: true });
  }
  for (const name of AI_SIDECARS) await writeFileReplacing(out, name, files[name], mode);
}

/**
 * The checks writeSidecars makes before it writes, without writing: no link
 * at any component, out a folder (or missing), and neither sidecar name a
 * link or a folder. widedoor suggest runs it before any request is paid for.
 * Throws OutputError.
 */
export async function checkSidecarOut(out: string, roots: readonly string[]) {
  await checkComponents(out, roots);
  if (await checkFolder(out)) for (const name of AI_SIDECARS) await checkFileName(join(out, name));
}

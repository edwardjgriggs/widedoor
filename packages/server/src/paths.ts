import { basename, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Local paths in text that leaves the machine's terminal: the widedoor ui
 * page, and the error text of a report (every export carries it). A file is
 * named relative to the root folder when inside it, else by its name, never
 * by an absolute path (CWE-209).
 */

/** A file as the page names it: relative to the root when inside it, else its name only (never an absolute path). */
export function rootRelative(root: string, file: string): string {
  const rel = relative(root, file);
  return rel === '' || rel.startsWith('..') || isAbsolute(rel)
    ? basename(file)
    : rel.split(sep).join('/');
}

/** Characters that end a path in a message: white space, quotes, angle brackets and a pipe. */
const PATH_REST = `[^\\s'"\`<>|]`;

/**
 * An absolute path in text: a drive path (C:\ or C:/, not the s:/ of
 * https://), a UNC path, or a POSIX path that starts a word (not the /
 * inside a URL, a media type or a relative path).
 */
const ABSOLUTE_PATH = new RegExp(
  `(?<![A-Za-z0-9])[A-Za-z]:[\\\\/]${PATH_REST}*|\\\\\\\\${PATH_REST}+|(?<![\\w.:/\\\\~-])/${PATH_REST}+`,
  'g',
);

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The last part of a path, or a fixed word for a bare drive or root. */
const lastPart = (path: string) => {
  const name =
    path
      .split(/[\\/]/)
      .filter((p) => p !== '')
      .pop() ?? '';
  return name === '' || /^[A-Za-z]:$/.test(name) ? 'a folder' : name;
};

export interface PathOptions {
  /** Folders whose files are named by their file name: the temp folder, the uploads folder, a stage. */
  folders?: readonly string[];
  /** The user's home folder, shown as ~ (the page only: the CLI's user knows their own paths). */
  home?: string;
  /**
   * Any other absolute path: 'name' gives its file name (the page, and a
   * widedoor ui report); 'keep' leaves it (a CLI report: its user typed it).
   */
  others?: 'name' | 'keep';
}

/** An opening quote that starts an absolute path (Node fs errors quote theirs). */
const QUOTE_OPENS_PATH = /(['"])(?=[A-Za-z]:[\\/]|\\\\|\/)/g;
/** What may follow a closing quote: the end of the text, space or punctuation. */
const AFTER_QUOTE = /^(?:$|[\s,;:.!?)\]}>-])/;

/**
 * The quoted absolute paths in text, each taken whole (spaces, and the
 * quote character itself, as in 'D:\O'Brien Files\a.pdf'). A quote closes
 * the path at the first quote of its kind followed by space, punctuation or
 * the end, else at the last one, looking no further than the line end or a
 * ", " (the next item of a list).
 */
function quotedPaths(text: string): { start: number; end: number; path: string }[] {
  const found: { start: number; end: number; path: string }[] = [];
  for (const m of text.matchAll(QUOTE_OPENS_PATH)) {
    const open = m.index;
    if (found.length > 0 && open < (found.at(-1) as { end: number }).end) continue;
    const quote = m[1] as string;
    const stops = [
      text.indexOf('\n', open),
      text.indexOf('\r', open),
      text.indexOf(', ', open + 1),
    ];
    const limit = Math.min(...stops.filter((i) => i >= 0), text.length);
    let close = -1;
    for (
      let i = text.indexOf(quote, open + 1);
      i >= 0 && i < limit;
      i = text.indexOf(quote, i + 1)
    ) {
      close = i;
      if (AFTER_QUOTE.test(text.slice(i + 1, limit).slice(0, 1))) break;
    }
    if (close > open + 1)
      found.push({ start: open, end: close + 1, path: text.slice(open + 1, close) });
  }
  return found;
}
/** A file URL. */
const FILE_URL = new RegExp(`file:\\/\\/${PATH_REST}*`, 'gi');

/**
 * Text with no absolute path in it that the reader should not see
 * (CWE-209): a path in the root is named relative to it (as rootRelative
 * does), one in home as ~/..., one in a known folder by its file name, and
 * any other by its file name (others: 'name', the default) or as it is
 * ('keep'). A quoted path is taken whole and a file:// URL as its path.
 * The terminal log keeps the full text.
 */
export function withoutPaths(text: string, root: string, options: PathOptions = {}): string {
  const windows = process.platform === 'win32';
  const others = options.others ?? 'name';
  // Longest first, so a folder inside the root (or the root inside a folder) wins.
  const known = [
    { dir: root, name: (rest: string) => rest.split(/[\\/]/).join('/') || '.' },
    ...(options.home !== undefined
      ? [
          {
            dir: options.home,
            name: (rest: string) => (rest ? `~/${rest.split(/[\\/]/).join('/')}` : '~'),
          },
        ]
      : []),
    ...(options.folders ?? []).map((dir) => ({ dir, name: lastPart })),
  ]
    .map((k) => ({ ...k, dir: k.dir.replace(/[\\/]+$/, '') }))
    .filter((k) => k.dir !== '')
    .sort((a, b) => b.dir.length - a.dir.length);
  const other = (path: string) => (others === 'keep' ? path : lastPart(path));

  // Separators as /, letter case folded on Windows: equal lengths, so slices line up.
  const fold = (path: string) => {
    const p = path.replace(/\\/g, '/');
    return windows ? p.toLowerCase() : p;
  };
  const inKnown = (path: string) => {
    const p = fold(path);
    return known.some(({ dir }) => p === fold(dir) || p.startsWith(`${fold(dir)}/`));
  };
  /** One whole absolute path, as the reader gets it. */
  const onePath = (path: string) => {
    const p = fold(path);
    for (const { dir, name } of known) {
      const d = fold(dir);
      if (p === d) return name('');
      if (p.startsWith(`${d}/`)) return name(path.slice(d.length + 1).replace(/^[\\/]+/, ''));
    }
    return other(path);
  };
  /**
   * Whether a quoted string is a file path: a drive or UNC path, or one in a
   * known folder, always. One starting with /: for the page ('name'), any
   * with a second / (so a route
   * such as "/api/report" shows as "report", which leaks nothing, while
   * '/var/lib/secret/data' never shows whole); for the CLI ('keep'), only one
   * in a known folder or naming a file (a dot in a name), so its user's routes
   * stay as written. A bare "/" or a single segment ("/api") stays either way.
   */
  const isFilePath = (path: string) =>
    !path.startsWith('/') ||
    inKnown(path) ||
    (others === 'name'
      ? path.indexOf('/', 1) > 1
      : path.split('/').some((part) => part.includes('.') && part !== '.' && part !== '..'));

  // Quoted paths and file URLs are settled first and set aside, so the passes
  // below never cut into them (a kept route stays as written).
  const aside: string[] = [];
  const setAside = (value: string) => `\uE000${aside.push(value) - 1}\uE001`;
  let out = text.replace(FILE_URL, (url) => {
    let path: string;
    try {
      path = fileURLToPath(url);
    } catch {
      return setAside(others === 'keep' ? url : lastPart(url));
    }
    const shown = onePath(path);
    // The CLI's user gave the URL: one not in a known folder stays the URL they gave.
    return setAside(others === 'keep' && shown === path ? url : shown);
  });
  let quoted = '';
  let from = 0;
  for (const { start, end, path } of quotedPaths(out)) {
    const q = out[start] as string;
    quoted += `${out.slice(from, start)}${setAside(`${q}${isFilePath(path) ? onePath(path) : path}${q}`)}`;
    from = end;
  }
  out = quoted + out.slice(from);
  for (const { dir, name } of known) {
    // Where a path starts a word (not inside a URL or a longer path); either separator;
    // alone, only before punctuation or the end, so a longer name that starts the same
    // (C:\root2 or C:\root.old for C:\root) is not it.
    const at = dir.split(/[\\/]/).map(escapeRegExp).join('[\\\\/]');
    out = out.replace(
      new RegExp(
        `(?<![\\w.:/\\\\-])${at}(?:[\\\\/](${PATH_REST}*)|(?![\\w-]|\\.\\w))`,
        windows ? 'gi' : 'g',
      ),
      (_, rest: string | undefined) => name(rest ?? ''),
    );
  }
  return out
    .replace(ABSOLUTE_PATH, other)
    .replace(/\uE000(\d+)\uE001/g, (_, i: string) => aside[Number(i)] as string);
}

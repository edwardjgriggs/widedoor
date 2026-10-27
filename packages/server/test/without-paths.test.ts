import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withoutPaths } from '../src/paths.ts';

/*
 * withoutPaths: what the page gets of a message that may name local files.
 * The root and the known folders are matched by the platform's own paths;
 * the other cases use fixed Windows and POSIX paths, which the fallback
 * handles the same on every platform.
 */

const root = join(process.cwd(), 'site root');
const uploads = join(process.cwd(), 'temp', 'widedoor-uploads-x');

describe('withoutPaths', () => {
  it('names a path in the root relative to it, with forward slashes', () => {
    expect(withoutPaths(`open '${join(root, 'widedoor-review', 'a.yaml')}'`, root)).toBe(
      "open 'widedoor-review/a.yaml'",
    );
    expect(withoutPaths(`in ${root}: nothing`, root)).toBe('in .: nothing');
  });

  it('does not take a sibling that starts with the root name for the root', () => {
    const plain = join(process.cwd(), 'r');
    expect(withoutPaths(`${plain}2${join('/', 'x.pdf')}`, plain)).toBe('x.pdf');
    expect(withoutPaths(`${plain}.old${join('/', 'y.pdf')}`, plain)).toBe('y.pdf');
    expect(withoutPaths(join(plain, 'x.pdf'), plain)).toBe('x.pdf');
  });

  it('names a path in a known folder by its file name, spaces and all', () => {
    expect(
      withoutPaths(`copy ${join(uploads, 'scan-1', 'pdf', 'annual report.pdf')}`, root, {
        folders: [uploads],
      }),
    ).toBe('copy annual report.pdf');
  });

  it('names any other absolute path by its file name', () => {
    expect(withoutPaths("ENOENT: open 'C:\\Users\\ann\\AppData\\x.pdf'", root)).toBe(
      "ENOENT: open 'x.pdf'",
    );
    expect(withoutPaths('read D:/data/b.pdf and \\\\server\\share\\c.pdf', root)).toBe(
      'read b.pdf and c.pdf',
    );
    expect(withoutPaths('spawn /usr/local/bin/docker ENOENT', root)).toBe('spawn docker ENOENT');
    // A path quoted as JSON (doubled backslashes).
    expect(withoutPaths('--attach "C:\\\\tmp\\\\u1\\\\a.png": no such file', root)).toBe(
      '--attach "a.png": no such file',
    );
    expect(withoutPaths('at C:\\ and /', root)).toBe('at a folder and /');
  });

  it('leaves URLs, media types and relative paths alone', () => {
    const text =
      'https://site.example/a/b and http://127.0.0.1:80/x, application/json, widedoor-review/a.yaml, 3/4 pages';
    expect(withoutPaths(text, root)).toBe(text);
  });

  it('leaves a URL whose path holds the root or a known folder alone', () => {
    // On POSIX these are the root and the temp folder in the URL's path; on Windows the
    // drive-less copies of them, which cannot match either.
    const work = join('/', 'work');
    const tmp = join('/', 'tmp');
    const text = `https://example.com/work/annual.pdf was not fetched: 404; https://example.com/tmp/x.pdf too`;
    expect(withoutPaths(text, work, { folders: [tmp] })).toBe(text);
    // A real path to either still goes.
    expect(
      withoutPaths(`open ${join(work, 'a.pdf')} and ${join(tmp, 'b.pdf')}`, work, {
        folders: [tmp],
      }),
    ).toBe('open a.pdf and b.pdf');
  });

  it('takes a quoted path whole, spaces and all', () => {
    expect(withoutPaths("open 'C:\\Users\\Jane Doe\\Documents\\a.pdf'", root)).toBe("open 'a.pdf'");
    expect(withoutPaths('open "/home/jane doe/My Files/b.pdf" failed', root)).toBe(
      'open "b.pdf" failed',
    );
    // In the root, still root-relative.
    expect(withoutPaths(`open '${join(root, 'my docs', 'c.pdf')}'`, root)).toBe(
      "open 'my docs/c.pdf'",
    );
  });

  it('takes a file URL to a local path as that path', () => {
    expect(withoutPaths('see file:///home/jane/secret/a.pdf now', root)).toBe('see a.pdf now');
    expect(withoutPaths(`see ${pathToFileURL(join(root, 'docs', 'b.pdf')).href}`, root)).toBe(
      'see docs/b.pdf',
    );
  });

  it('shows a path in home as ~ when home is given', () => {
    const home = join(process.cwd(), 'home dir');
    expect(withoutPaths(`open '${join(home, 'Documents', 'a.pdf')}'`, root, { home })).toBe(
      "open '~/Documents/a.pdf'",
    );
    expect(withoutPaths(`at ${home}`, root, { home })).toBe('at ~');
  });

  it("keeps other paths with others: 'keep', but still names temp paths by their name", () => {
    const tmp = join(process.cwd(), 'tmp-x');
    const typed = join(process.cwd(), '..', 'elsewhere', 'a.pdf');
    expect(
      withoutPaths(
        `scan ${typed}: copy ${join(tmp, 'v', 'in.pdf')}; ${join(root, 'b.pdf')}`,
        root,
        { folders: [tmp], others: 'keep' },
      ),
    ).toBe(`scan ${typed}: copy in.pdf; b.pdf`);
  });

  it("keeps a file URL the CLI user gave as that URL under others: 'keep'", () => {
    const typed = pathToFileURL(join(process.cwd(), '..', 'elsewhere', 'a.pdf')).href;
    expect(withoutPaths(`scan ${typed} failed`, root, { others: 'keep' })).toBe(
      `scan ${typed} failed`,
    );
    // Into the root it is still named root-relative, and on the page by its name.
    expect(
      withoutPaths(`scan ${pathToFileURL(join(root, 'b.pdf')).href}`, root, { others: 'keep' }),
    ).toBe('scan b.pdf');
    expect(withoutPaths(`scan ${typed} failed`, root)).toBe('scan a.pdf failed');
  });

  it('names a quoted POSIX path with no dot by its last part on the page', () => {
    expect(
      withoutPaths("ENOENT: no such file or directory, open '/var/lib/secret/data'", root),
    ).toBe("ENOENT: no such file or directory, open 'data'");
    expect(withoutPaths("EACCES: permission denied, mkdir '/opt/acme/clients/jane'", root)).toBe(
      "EACCES: permission denied, mkdir 'jane'",
    );
    // A route shows as its last part, which names nothing local.
    expect(withoutPaths('GET "/api/report" answered 404', root)).toBe('GET "report" answered 404');
    expect(withoutPaths("open '/srv/data/x.pdf'", root)).toBe("open 'x.pdf'");
  });

  it('leaves a quoted bare / and a single segment as written', () => {
    for (const options of [{}, { others: 'keep' as const }]) {
      expect(withoutPaths("'/' is not allowed", root, options)).toBe("'/' is not allowed");
      expect(withoutPaths('GET "/api" answered 404', root, options)).toBe(
        'GET "/api" answered 404',
      );
    }
  });

  it("leaves a quoted route as written for the CLI (others: 'keep'), but names a file", () => {
    expect(withoutPaths('GET "/api/report" answered 404', root, { others: 'keep' })).toBe(
      'GET "/api/report" answered 404',
    );
    expect(withoutPaths("open '/var/lib/secret/data'", root, { others: 'keep' })).toBe(
      "open '/var/lib/secret/data'",
    );
    const tmp = join(process.cwd(), 'tmp-y');
    expect(
      withoutPaths(`copy '${join(tmp, 'v', 'in.pdf')}'`, root, { folders: [tmp], others: 'keep' }),
    ).toBe("copy 'in.pdf'");
  });

  it('takes a quoted path that holds its own quote character whole', () => {
    expect(withoutPaths("open 'D:\\O'Brien Files\\x y\\a.pdf'", root)).toBe("open 'a.pdf'");
    expect(withoutPaths("open 'D:\\O'Brien Files\\x y\\a.pdf', then b", root)).toBe(
      "open 'a.pdf', then b",
    );
    // Two quoted paths on one line stay two (Node's rename errors read this way).
    expect(withoutPaths("rename 'C:\\a\\x.pdf' -> 'C:\\b\\y.pdf'", root)).toBe(
      "rename 'x.pdf' -> 'y.pdf'",
    );
  });
});

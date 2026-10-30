import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  AI_SIDECARS,
  MARKER,
  OutputError,
  prepareOut,
  writeReport,
  writeSidecars,
} from '../src/output.ts';

/*
 * The report folder refuses links and is cleared only when it carries the
 * Widedoor marker (ledger rulings, Task 1.4 fix rounds 1 and 2). A junction
 * stands in for a folder link on Windows; a file link is planted where the
 * account may create one, else a junction takes its place.
 */

const root = mkdtempSync(join(tmpdir(), 'widedoor-out-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
const fresh = () => {
  const dir = join(root, `t${n++}`);
  mkdirSync(dir);
  const victim = join(dir, 'victim');
  mkdirSync(victim);
  writeFileSync(join(victim, 'keep.txt'), 'original');
  return { dir, victim, out: join(dir, 'widedoor-report') };
};

/** A link at path to a file: a file symlink where allowed, else a junction to its folder. */
function linkToFile(file: string, folder: string, path: string) {
  try {
    symlinkSync(file, path, 'file');
  } catch {
    symlinkSync(folder, path, 'junction');
  }
}

const untouched = (victim: string) => {
  expect(readdirSync(victim)).toEqual(['keep.txt']);
  expect(readFileSync(join(victim, 'keep.txt'), 'utf8')).toBe('original');
};

describe('prepareOut: ownership marker', () => {
  it('creates a missing folder with the marker and evidence/', async () => {
    const { dir, out } = fresh();
    await prepareOut(join(out, 'nested'), false, [dir]);
    expect(readdirSync(join(out, 'nested')).sort()).toEqual([MARKER, 'evidence']);
  });

  it('adopts an empty folder by writing the marker', async () => {
    const { dir, out } = fresh();
    mkdirSync(out);
    await prepareOut(out, false, [dir]);
    expect(existsSync(join(out, MARKER))).toBe(true);
  });

  it('refuses a non-empty folder without the marker and deletes nothing', async () => {
    const { dir } = fresh();
    writeFileSync(join(dir, 'report.html'), 'my own report');
    mkdirSync(join(dir, 'evidence'));
    writeFileSync(join(dir, 'evidence', 'wd_0123456789abcdef.png'), 'mine');
    // --out . : the working folder itself.
    await expect(prepareOut(dir, false, [dir])).rejects.toThrow(
      /is not empty and has no \.widedoor-report marker/,
    );
    expect(readFileSync(join(dir, 'report.html'), 'utf8')).toBe('my own report');
    expect(readdirSync(join(dir, 'evidence'))).toEqual(['wd_0123456789abcdef.png']);
    expect(existsSync(join(dir, MARKER))).toBe(false);
  });

  it('with the marker, clears every report format, evidence/ and stale temp files', async () => {
    const { dir, out } = fresh();
    await prepareOut(out, false, [dir]);
    for (const name of [
      'report.html',
      'report.json',
      'report.sarif',
      '.report.json.0123456789ab.tmp',
      // Two dots in the format's extension (3b.7 fix round 1 item 5).
      '.report.vpat.docx.0123456789ab.tmp',
      '.report.junit.xml.abcdef012345.tmp',
    ])
      writeFileSync(join(out, name), 'old');
    writeFileSync(join(out, 'evidence', 'wd_0123456789abcdef.png'), 'old');
    writeFileSync(join(out, 'evidence', '.wd_0123456789abcdef.png.0123456789ab.tmp'), 'old');
    writeFileSync(join(out, 'notes.txt'), 'kept');
    await prepareOut(out, false, [dir]);
    expect(readdirSync(out).sort()).toEqual([MARKER, 'evidence', 'notes.txt']);
    expect(readdirSync(join(out, 'evidence'))).toEqual([]);
  });

  it('refuses to clear a folder or link inside evidence/', async () => {
    const t = fresh();
    await prepareOut(t.out, false, [t.dir]);
    symlinkSync(t.victim, join(t.out, 'evidence', 'x'), 'junction');
    await expect(prepareOut(t.out, false, [t.dir])).rejects.toThrow(/is not a file Widedoor wrote/);
    untouched(t.victim);
  });
});

describe('prepareOut: links', () => {
  it('refuses a junction or link at the folder, at evidence/ and at a report name', async () => {
    const cases: [string, (t: ReturnType<typeof fresh>) => void][] = [
      ['folder', (t) => symlinkSync(t.victim, t.out, 'junction')],
      [
        'evidence',
        (t) => {
          mkdirSync(t.out);
          symlinkSync(t.victim, join(t.out, 'evidence'), 'junction');
        },
      ],
      [
        'report.json',
        (t) => {
          mkdirSync(t.out);
          linkToFile(join(t.victim, 'keep.txt'), t.victim, join(t.out, 'report.json'));
        },
      ],
      [
        'report.html',
        (t) => {
          mkdirSync(t.out);
          linkToFile(join(t.victim, 'keep.txt'), t.victim, join(t.out, 'report.html'));
        },
      ],
      [
        'marker',
        (t) => {
          mkdirSync(t.out);
          linkToFile(join(t.victim, 'keep.txt'), t.victim, join(t.out, MARKER));
        },
      ],
    ];
    for (const [what, plant] of cases) {
      const t = fresh();
      plant(t);
      await expect(prepareOut(t.out, false, [t.dir]), what).rejects.toThrow(OutputError);
      await expect(prepareOut(t.out, false, [t.dir]), what).rejects.toThrow(
        /symbolic link or junction/,
      );
      untouched(t.victim);
    }
  });

  it('refuses a linked intermediate folder in --out, existing or about to be created through', async () => {
    const t = fresh();
    // build -> victim, then --out build/a11y (missing) and build/sub (existing in the target).
    symlinkSync(t.victim, join(t.dir, 'build'), 'junction');
    for (const out of [join(t.dir, 'build', 'a11y'), join(t.dir, 'build')]) {
      await expect(prepareOut(out, false, [t.dir]), out).rejects.toThrow(
        `${join(t.dir, 'build')} is a symbolic link or junction`,
      );
    }
    untouched(t.victim);
  });

  it('checks components below the config folder too', async () => {
    const t = fresh();
    const config = join(t.dir, 'site');
    mkdirSync(config);
    symlinkSync(t.victim, join(config, 'out'), 'junction');
    await expect(
      prepareOut(join(config, 'out', 'r'), false, [join(root, 'elsewhere'), config]),
    ).rejects.toThrow(/out is a symbolic link or junction/);
    untouched(t.victim);
  });

  it('refuses a folder at a report name and a file at the folder', async () => {
    const t = fresh();
    mkdirSync(join(t.out, 'report.json'), { recursive: true });
    await expect(prepareOut(t.out, false, [t.dir])).rejects.toThrow(
      /is a folder, not a report file/,
    );
    const file = join(t.dir, 'a-file');
    writeFileSync(file, 'x');
    await expect(prepareOut(file, false, [t.dir])).rejects.toThrow(/is not a folder/);
  });
});

describe('writeReport', () => {
  it('writes fresh through a temp file and leaves no temp file behind', async () => {
    const { dir, out } = fresh();
    await prepareOut(out, false, [dir]);
    await writeReport(out, 'json', '{"a":1}\n', false);
    await writeReport(out, 'json', '{"a":2}\n', false);
    expect(readFileSync(join(out, 'report.json'), 'utf8')).toBe('{"a":2}\n');
    expect(readdirSync(out).sort()).toEqual([MARKER, 'evidence', 'report.json']);
  });

  it('refuses a link planted after the folder was prepared, and the target stays untouched', async () => {
    const t = fresh();
    await prepareOut(t.out, false, [t.dir]);
    linkToFile(join(t.victim, 'keep.txt'), t.victim, join(t.out, 'report.json'));
    await expect(writeReport(t.out, 'json', 'pwned', false)).rejects.toThrow(/symbolic link/);
    untouched(t.victim);
  });

  it.skipIf(process.platform === 'win32')('creates private files when restricted', async () => {
    const { dir, out } = fresh();
    await prepareOut(out, true, [dir]);
    await writeReport(out, 'json', '{}', true);
    expect(statSync(out).mode & 0o777).toBe(0o700);
    expect(statSync(join(out, 'report.json')).mode & 0o777).toBe(0o600);
  });
});

// Task 3b.7 item 5a and fix round 1 item 6: the AI suggestions sidecars, written as a pair.
const pair = (tag: string) => ({
  'ai-suggestions.json': `{"run":"${tag}"}`,
  'ai-suggestions.html': `<p>${tag}</p>`,
});

describe('writeSidecars', () => {
  it('writes both through temp files and renames, leaves no temp file and keeps the report', async () => {
    const { dir, out } = fresh();
    await prepareOut(out, false, [dir]);
    await writeReport(out, 'json', '{"report":1}', false);
    await writeSidecars(out, pair('1'), false, [dir]);
    await writeSidecars(out, pair('2'), false, [dir]);
    expect(readFileSync(join(out, 'ai-suggestions.json'), 'utf8')).toBe('{"run":"2"}');
    expect(readFileSync(join(out, 'ai-suggestions.html'), 'utf8')).toBe('<p>2</p>');
    expect(readFileSync(join(out, 'report.json'), 'utf8')).toBe('{"report":1}');
    expect(readdirSync(out).sort()).toEqual(
      [MARKER, ...AI_SIDECARS, 'evidence', 'report.json'].sort(),
    );
  });

  it('never pairs a new JSON with an old HTML when the write stops between them', async () => {
    const { dir, out } = fresh();
    await prepareOut(out, false, [dir]);
    await writeSidecars(out, pair('old'), false, [dir]);
    const files = {
      'ai-suggestions.json': '{"run":"new"}',
      get 'ai-suggestions.html'(): string {
        throw new Error('stopped');
      },
    };
    await expect(writeSidecars(out, files, false, [dir])).rejects.toThrow('stopped');
    expect(readFileSync(join(out, 'ai-suggestions.json'), 'utf8')).toBe('{"run":"new"}');
    expect(existsSync(join(out, 'ai-suggestions.html'))).toBe(false);
  });

  // Final fix round 1 item 22: a folder that is not Widedoor's loses nothing but the two names.
  it('in a folder without the marker, deletes nothing and writes only the two files', async () => {
    const { dir } = fresh();
    const foreign = join(dir, 'theirs');
    mkdirSync(foreign);
    writeFileSync(join(foreign, '.ai-suggestions.json.0123456789ab.tmp'), 'theirs');
    writeFileSync(join(foreign, 'notes.txt'), 'theirs');
    await writeSidecars(foreign, pair('1'), false, [dir]);
    expect(readdirSync(foreign).sort()).toEqual(
      ['.ai-suggestions.json.0123456789ab.tmp', ...AI_SIDECARS, 'notes.txt'].sort(),
    );
  });

  it('sweeps stale sidecar temps, and leaves a report temp to prepareOut', async () => {
    const { dir, out } = fresh();
    await prepareOut(out, false, [dir]);
    for (const name of [
      '.ai-suggestions.json.0123456789ab.tmp',
      '.ai-suggestions.html.abcdef012345.tmp',
    ])
      writeFileSync(join(out, name), 'half');
    writeFileSync(join(out, '.report.json.0123456789ab.tmp'), 'half');
    await writeSidecars(out, pair('1'), false, [dir]);
    expect(readdirSync(out).sort()).toEqual(
      [MARKER, '.report.json.0123456789ab.tmp', ...AI_SIDECARS, 'evidence'].sort(),
    );
  });

  it('creates a missing folder, and refuses a link at either name with the target untouched', async () => {
    const t = fresh();
    await writeSidecars(join(t.dir, 'new'), pair('1'), false, [t.dir]);
    // A folder writeSidecars creates gets the marker (final fix round 1 item 22).
    expect(readdirSync(join(t.dir, 'new')).sort()).toEqual([MARKER, ...AI_SIDECARS].sort());
    for (const name of AI_SIDECARS) {
      const out = join(t.dir, `linked-${name}`);
      await prepareOut(out, false, [t.dir]);
      linkToFile(join(t.victim, 'keep.txt'), t.victim, join(out, name));
      await expect(writeSidecars(out, pair('pwned'), false, [t.dir])).rejects.toThrow(
        /symbolic link/,
      );
      untouched(t.victim);
    }
  });

  it('prepareOut clears sidecars and their stale temp files from an earlier run', async () => {
    const { dir, out } = fresh();
    await prepareOut(out, false, [dir]);
    await writeSidecars(out, pair('old'), false, [dir]);
    writeFileSync(join(out, '.ai-suggestions.json.0123456789ab.tmp'), 'half');
    await prepareOut(out, false, [dir]);
    expect(readdirSync(out).sort()).toEqual([MARKER, 'evidence'].sort());
  });
});

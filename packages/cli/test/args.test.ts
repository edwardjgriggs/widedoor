import { describe, expect, it } from 'vitest';
import { UsageError, parseCommand } from '../src/args.ts';

describe('parseCommand', () => {
  it('parses a scan with every flag', () => {
    expect(
      parseCommand([
        'scan',
        'https://example.com/',
        'docs/a.pdf',
        '--config',
        'w.yaml',
        '--profile',
        'wcag21aa',
        '--format',
        'json, sarif,json',
        '--out',
        'out',
        '--fail-on',
        'moderate',
        '--concurrency',
        '4',
        '--memory',
        '1024',
        '--unsafe-no-sandbox',
      ]),
    ).toEqual({
      command: 'scan',
      targets: ['https://example.com/', 'docs/a.pdf'],
      config: 'w.yaml',
      profile: 'wcag21aa',
      formats: ['json', 'sarif'],
      out: 'out',
      failOn: 'moderate',
      concurrency: 4,
      memoryMb: 1024,
      unsafeNoSandbox: true,
    });
  });

  it('leaves unset flags out, so the config and defaults apply', () => {
    expect(parseCommand(['scan'])).toEqual({
      command: 'scan',
      targets: [],
      unsafeNoSandbox: false,
    });
  });

  it('answers --help and --version before anything else', () => {
    expect(parseCommand(['--help'])).toEqual({ command: 'help' });
    expect(parseCommand(['scan', '-h', '--format', 'bogus'])).toEqual({ command: 'help' });
    expect(parseCommand(['-v'])).toEqual({ command: 'version' });
  });

  it.each([
    [[], /no command given/],
    [['review'], /unknown command "review"/],
    [['scan', '--bogus'], /Unknown option '--bogus'/],
    [['scan', '--profile', '2.2'], /--profile must be one of 508, wcag21aa, 508\+wcag21aa/],
    [['scan', '--format', 'pdf'], /--format must be one of html, json, sarif/],
    [['scan', '--format', 'html,,json'], /comma-separated list/],
    [
      ['scan', '--fail-on', 'high'],
      /--fail-on must be one of critical, serious, moderate, minor, none/,
    ],
    [['scan', '--concurrency', '0'], /--concurrency must be a whole number from 1 to 32/],
    [['scan', '--concurrency', '1.5'], /--concurrency/],
    [['scan', '--memory', '64'], /--memory must be a whole number from 256/],
    [['scan', '--out', ''], /--out needs a folder/],
    [['scan', '--config'], /argument missing/],
  ])('refuses %j', (argv, message) => {
    expect(() => parseCommand(argv)).toThrow(UsageError);
    expect(() => parseCommand(argv)).toThrow(message);
  });
});

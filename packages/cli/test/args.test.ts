import { describe, expect, it } from 'vitest';
import {
  ACR_FORMATS,
  DEFAULT_FORMATS,
  FORMATS,
  USAGE,
  UsageError,
  parseCommand,
} from '../src/args.ts';

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
      ignoreOverrides: false,
      ai: { fixes: false, dryRun: false },
    });
  });

  it('takes --ignore-overrides for scan only', () => {
    expect(parseCommand(['scan', '--ignore-overrides'])).toMatchObject({ ignoreOverrides: true });
    expect(USAGE).toContain('--ignore-overrides');
    expect(() => parseCommand(['ui', '--ignore-overrides'])).toThrow(
      /--ignore-overrides is not an option of widedoor ui/,
    );
  });

  it('takes junit as an opt-in format', () => {
    expect(parseCommand(['scan', '--format', 'junit,json'])).toMatchObject({
      formats: ['junit', 'json'],
    });
    expect(DEFAULT_FORMATS).toEqual(['html', 'json', 'sarif']);
    expect(FORMATS).toContain('junit');
  });

  it('takes openacr as an opt-in format', () => {
    expect(parseCommand(['scan', '--format', 'openacr,json'])).toMatchObject({
      formats: ['openacr', 'json'],
    });
    expect(DEFAULT_FORMATS).not.toContain('openacr');
    expect(USAGE).toContain('openacr writes the ACR as report.openacr.yaml');
  });

  it('takes vpat-html and vpat-docx as opt-in ACR formats', () => {
    expect(parseCommand(['scan', '--format', 'vpat-html,vpat-docx'])).toMatchObject({
      formats: ['vpat-html', 'vpat-docx'],
    });
    expect(DEFAULT_FORMATS).not.toContain('vpat-html');
    expect(DEFAULT_FORMATS).not.toContain('vpat-docx');
    expect(ACR_FORMATS).toEqual(['openacr', 'vpat-html', 'vpat-docx']);
    expect(USAGE).toContain('vpat-html and vpat-docx as report.vpat.html and');
  });

  it('leaves unset flags out, so the config and defaults apply', () => {
    expect(parseCommand(['scan'])).toEqual({
      command: 'scan',
      targets: [],
      unsafeNoSandbox: false,
      ignoreOverrides: false,
      ai: { fixes: false, dryRun: false },
    });
  });

  it('answers --help and --version before anything else', () => {
    expect(parseCommand(['--help'])).toEqual({ command: 'help' });
    expect(parseCommand(['scan', '-h', '--format', 'bogus'])).toEqual({ command: 'help' });
    expect(parseCommand(['-v'])).toEqual({ command: 'version' });
  });

  it.each([
    [[], /no command given/],
    [['audit'], /unknown command "audit"; expected scan, ui, review, diff or suggest/],
    [['scan', '--bogus'], /Unknown option '--bogus'/],
    [['scan', '--profile', '2.2'], /--profile must be one of 508, wcag21aa, 508\+wcag21aa/],
    [['scan', '--format', 'pdf'], /--format must be one of html, json, sarif, junit/],
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

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ATTACHMENT_DIR,
  FindingSchema,
  findingId,
  getProfile,
  type Asset,
  type Finding,
  type Location,
} from '@widedoor/core';
import { buildScanReport, type ScanReport } from '../src/index.ts';
import { PAYLOAD } from './fixture.ts';

/*
 * A fixed 508+wcag21aa scan of one web page and one PDF with the manual
 * review cases the reporters treat differently: an override that sets an
 * automated fail aside (hostile reviewer and notes), an automated fail that
 * still counts, 4.1.1 passing on the errata basis, an expired review, and
 * attachments: a real PNG, a real JPEG, a PNG header followed by HTML, and
 * one that names a missing file. writeAttachments puts the files under
 * widedoor-review/attachments.
 */

const hash = (c: string) => `sha256:${c.repeat(64)}`;
export const PAGE: Asset = {
  kind: 'web',
  uri: 'https://example.gov/apply',
  contentHash: hash('a'),
};
export const PDF: Asset = { kind: 'pdf', uri: 'docs/form.pdf', contentHash: hash('b') };

/** A 1x1 grey PNG and a 1x1 grey JPEG, whole files. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
export const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/ACv/2Q==',
  'base64',
);
/** The first bytes of a PNG, then a page of HTML: passes a signature check, not a whole-file one. */
export const PNG_THEN_HTML = Buffer.concat([
  PNG.subarray(0, 16),
  Buffer.from('<html><script>alert(1)</script></html>'),
]);

export const ATTACHMENTS = {
  png: 'attachments/ck_0123456789abcdef-1-0a1b2c3d.png',
  jpeg: 'attachments/ck_0123456789abcdef-2-0a1b2c3d.jpg',
  html: 'attachments/ck_fedcba9876543210-1-0a1b2c3d.png',
  missing: 'attachments/ck_fedcba9876543210-2-0a1b2c3d.png',
};

/** Writes the attachment files under dir/widedoor-review/attachments; returns that folder. */
export function writeAttachments(dir: string): string {
  const folder = join(dir, ATTACHMENT_DIR);
  mkdirSync(folder, { recursive: true });
  const at = (path: string) => join(folder, path.slice('attachments/'.length));
  writeFileSync(at(ATTACHMENTS.png), PNG);
  writeFileSync(at(ATTACHMENTS.jpeg), JPEG);
  writeFileSync(at(ATTACHMENTS.html), PNG_THEN_HTML);
  return folder;
}

function automated(
  asset: Asset,
  location: Location,
  engine: 'axe-core' | 'verapdf',
  ruleId: string,
  rest: Partial<Finding>,
): Finding {
  return FindingSchema.parse({
    schemaVersion: 1,
    id: findingId(asset.uri, location, engine, ruleId),
    asset,
    location,
    source: { engine, engineVersion: engine === 'axe-core' ? '4.14.0' : '1.30.3', ruleId },
    criteria: { wcag: ['1.1.1'] },
    outcome: 'fail',
    ...rest,
  });
}

/** A manual record with the identity Task 2.4 writes (rule wcag-<sc>, page-level location). */
function manual(
  asset: Asset,
  sc: string,
  outcome: 'pass' | 'fail',
  review: Record<string, unknown>,
): Finding {
  const location: Location = asset.kind === 'web' ? { selector: 'html' } : {};
  const ruleId = `wcag-${sc}`;
  return FindingSchema.parse({
    schemaVersion: 1,
    id: findingId(asset.uri, location, 'manual', ruleId),
    asset,
    location,
    source: { engine: 'manual', engineVersion: '0.2.0', ruleId },
    criteria: { wcag: [sc] },
    outcome,
    review: { date: '2026-10-22', expiresOnChangeOf: asset.contentHash, ...review },
  });
}

export const HERO = automated(PAGE, { selector: 'img.hero' }, 'axe-core', 'image-alt', {
  impact: 'critical',
  evidence: { snippet: '<img class="hero" src="hero.png">' },
});
export const CONTRAST = automated(PAGE, { selector: 'p.faint' }, 'axe-core', 'color-contrast', {
  criteria: { wcag: ['1.4.3'] },
  impact: 'serious',
});
export const FIGURE = automated(PDF, { page: 1 }, 'verapdf', '7.3-1', { impact: 'serious' });

export const REVIEWER = `Ada ${PAYLOAD}`;
export const NOTES = `The hero image is decorative; axe misreads its role. ${PAYLOAD}`;

export const OVERRIDE = manual(PAGE, '1.1.1', 'pass', {
  reviewer: REVIEWER,
  notes: NOTES,
  overrides: [HERO.id],
  attachments: [ATTACHMENTS.png, ATTACHMENTS.html],
});
export const KEYBOARD = manual(PAGE, '2.1.1', 'pass', {
  reviewer: 'Grace Hopper',
  notes: 'Tabbed through every control.',
  // The PNG again: it is embedded (and counted) once, at the first record that names it.
  attachments: [ATTACHMENTS.jpeg, ATTACHMENTS.missing, ATTACHMENTS.png],
});
/** Recorded against older content of the PDF, so it no longer counts. */
export const EXPIRED = manual(PDF, '1.3.2', 'pass', {
  reviewer: 'Grace Hopper',
  notes: 'Reading order checked in a screen reader.',
  expiresOnChangeOf: hash('9'),
});

export function reviewFixtureReport(): ScanReport {
  return buildScanReport({
    profile: getProfile('508+wcag21aa'),
    startedAt: '2026-10-23T12:00:00.000Z',
    finishedAt: '2026-10-23T12:05:00.000Z',
    toolVersion: '0.0.0',
    scope: {
      web: { urls: [PAGE.uri], truncated: false },
      pdf: { files: [PDF.uri], include: [] },
    },
    web: {
      engine: { name: 'axe-core', version: '4.14.0' },
      assets: [PAGE],
      findings: [HERO, CONTRAST],
      errors: [],
      skipped: [],
      warnings: [],
      truncated: false,
      pages: [{ asset: PAGE, title: 'Apply for a permit' }],
    },
    pdf: {
      engines: {
        verapdf: { version: '1.30.3', runner: 'docker', description: null },
        widedoor: { version: '0.0.0' },
      },
      assets: [PDF],
      findings: [FIGURE],
      informational: [],
      errors: [],
      warnings: [],
    },
    reviews: [OVERRIDE, KEYBOARD, EXPIRED],
    warnings: [`manual review record wd_0 (wcag-9.9.9) was left out: orphaned: ${PAYLOAD}`],
  });
}

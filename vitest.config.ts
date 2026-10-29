import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (path: string) => fileURLToPath(new URL(`./packages/${path}`, import.meta.url));

const include = [
  'packages/*/test/**/*.test.tsx',
  'packages/*/test/**/*.test.ts',
  'packages/*/src/**/*.test.ts',
  'corpus/test/**/*.test.ts',
];
const browser = '**/*.browser.test.ts';
const docker = '**/*.docker.test.ts';
const image = '**/*.image.test.ts';
// Unscoped on purpose: any test file with "ssrf" in its name joins the deploy gate and leaves unit and browser.
const ssrf = '**/*ssrf*.test.ts';
const modules = '**/node_modules/**';

export default defineConfig({
  resolve: {
    // Tests run against package sources, not a dist/ that may be stale.
    alias: [
      { find: /^@widedoor\/core$/, replacement: src('core/src/index.ts') },
      { find: /^@widedoor\/core\/browser$/, replacement: src('core/src/browser.ts') },
      { find: /^@widedoor\/web$/, replacement: src('web/src/index.ts') },
      { find: /^@widedoor\/web\/egress$/, replacement: src('web/src/egress/index.ts') },
      { find: /^@widedoor\/pdf$/, replacement: src('pdf/src/index.ts') },
      { find: /^@widedoor\/report$/, replacement: src('report/src/index.ts') },
      { find: /^@widedoor\/report\/browser$/, replacement: src('report/src/browser.ts') },
      { find: /^@widedoor\/server$/, replacement: src('server/src/index.ts') },
    ],
  },
  test: {
    passWithNoTests: true,
    projects: [
      // npm test: offline, no browser, no Docker.
      {
        extends: true,
        // A few offline tests (decompression bombs, hashing the ACT corpus, the hostile DOM probe)
        // take seconds; 30 s keeps them from failing on a busy host.
        test: {
          name: 'unit',
          include,
          exclude: [browser, docker, image, ssrf, modules],
          testTimeout: 30_000,
        },
      },
      // npm run test:browser: Chromium against 127.0.0.1 and temp files (needs `npx playwright install chromium`).
      {
        extends: true,
        test: {
          name: 'browser',
          include: [browser],
          exclude: [ssrf, modules],
          testTimeout: 60_000,
        },
      },
      // npm run test:ssrf: the deploy gate of the hosted tier; Chromium and Node fetches through the egress proxy.
      {
        extends: true,
        test: {
          name: 'ssrf',
          include: [ssrf],
          exclude: [modules],
          testTimeout: 120_000,
          fileParallelism: false,
        },
      },
      // npm run test:docker: veraPDF in the pinned image (docker pull verapdf/cli:v1.30.3 first).
      {
        extends: true,
        test: {
          name: 'docker',
          include: [docker],
          exclude: [modules],
          testTimeout: 300_000,
          fileParallelism: false,
        },
      },
      // npm run test:image: builds the widedoor:dev image (Dockerfile) and scans the corpus with it,
      // and builds the scan and hosted targets and tests the scan machine's lockdown.
      {
        extends: true,
        test: {
          name: 'image',
          include: [image],
          exclude: [modules],
          testTimeout: 300_000,
          fileParallelism: false,
        },
      },
    ],
  },
});

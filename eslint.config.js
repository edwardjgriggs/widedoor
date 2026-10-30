import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// The viewer renders scanned content: it may only ever create text nodes (ledger ruling, Task 1.5).
const HTML_SINK = 'The UI renders text only: no HTML string sinks (spec section 8).';
const RAW_URL =
  'Links and images take only checked URLs: use SafeLink, or a data: URI checked by ScreenshotsSchema.';
const sinkNames =
  '/^(innerHTML|outerHTML|insertAdjacentHTML|setHTMLUnsafe|parseHTMLUnsafe|parseFromString|createContextualFragment)$/';
const htmlSinks = [
  { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: HTML_SINK },
  { selector: "Property[key.name='dangerouslySetInnerHTML']", message: HTML_SINK },
  { selector: "Property[key.value='dangerouslySetInnerHTML']", message: HTML_SINK },
  { selector: 'JSXAttribute[name.name=/^src[Dd]oc$/]', message: HTML_SINK },
  { selector: `MemberExpression[property.name=${sinkNames}]`, message: HTML_SINK },
  { selector: `MemberExpression[property.value=${sinkNames}]`, message: HTML_SINK },
  { selector: `Identifier[name=${sinkNames}]`, message: HTML_SINK },
  {
    selector: "MemberExpression[object.name='document'][property.name=/^(write|writeln)$/]",
    message: HTML_SINK,
  },
  {
    selector: "MemberExpression[object.name='document'][property.value=/^(write|writeln)$/]",
    message: HTML_SINK,
  },
  { selector: "MemberExpression[property.name='execCommand']", message: HTML_SINK },
  {
    selector:
      'JSXOpeningElement[name.name=/^(iframe|frame|object|embed|script|base|meta|link|form|svg)$/]',
    message: HTML_SINK,
  },
  {
    selector: "JSXOpeningElement[name.name='a'] > JSXAttribute[name.name='href']",
    message: RAW_URL,
  },
  {
    selector: "JSXOpeningElement[name.name='img'] > JSXAttribute[name.name='src']",
    message: RAW_URL,
  },
];

// Code the browser bundle runs must not reach Node built-ins or the Node-only modules.
const NODE_ONLY =
  'Browser code: no Node built-ins and no Node-only module (use the ./browser entries).';
const nodeBuiltins = [
  'assert',
  'buffer',
  'child_process',
  'crypto',
  'events',
  'fs',
  'fs/promises',
  'http',
  'https',
  'module',
  'net',
  'os',
  'path',
  'process',
  'stream',
  'url',
  'util',
  'worker_threads',
  'zlib',
];
const browserImports = (nodeOnlyModules) => [
  'error',
  {
    paths: [
      ...nodeBuiltins.map((name) => ({ name, message: NODE_ONLY })),
      { name: 'yaml', message: NODE_ONLY },
      { name: '@widedoor/core', message: NODE_ONLY, allowTypeImports: true },
      { name: '@widedoor/report', message: NODE_ONLY, allowTypeImports: true },
    ],
    patterns: [
      { group: ['node:*'], message: NODE_ONLY },
      ...(nodeOnlyModules.length
        ? [{ group: nodeOnlyModules, message: NODE_ONLY, allowTypeImports: true }]
        : []),
    ],
  },
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', 'evidence/**', '.widedoor/**', 'corpus/act/**'] },
  // A disable comment that no longer suppresses anything is an error (lint.test.ts counts them).
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/ui/**/*.{ts,tsx,js,jsx}'],
    // Declared so no-implied-eval can see string timers through these globals.
    languageOptions: {
      globals: {
        window: 'readonly',
        self: 'readonly',
        globalThis: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
      },
    },
    rules: {
      'no-restricted-syntax': ['error', ...htmlSinks],
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-implied-eval': 'error',
    },
  },
  {
    files: ['packages/ui/src/**/*.{ts,tsx}'],
    rules: { '@typescript-eslint/no-restricted-imports': browserImports([]) },
  },
  {
    files: [
      'packages/report/src/{browser,model,json,summary,view,viewer,plain-data,links,style,escape}.ts',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': browserImports([
        './plain.js',
        './evidence.js',
        './html.js',
        './sarif.js',
        './build.js',
        './version.js',
        './index.js',
      ]),
    },
  },
  // D16: AI suggestions run in the CLI only; the local server gets them as a capability the CLI
  // injects. This is the core rule, not the typescript-eslint one set above, so neither replaces
  // the other; boundary.test.ts also catches import() and require.
  {
    files: ['packages/server/src/**', 'packages/ui/src/**', 'packages/web/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@widedoor/ai', '@widedoor/ai/*'],
              message:
                'D16: @widedoor/ai is loaded by the CLI only; the server package (which the hosted image installs), the UI bundle and the web engine never import it.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/core/src/{browser,schema,profile-ids,rollup,checklist,sha256}.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': browserImports([
        './data.js',
        './profiles.js',
        './finding-id.js',
        './index.js',
      ]),
    },
  },
);

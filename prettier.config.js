export default {
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 100,
  overrides: [
    {
      // The report markup lives in html`...` templates whose exact text is the output (the CSP
      // hashes the style block), so Prettier must not reformat them as embedded HTML.
      files: 'packages/report/**/*.ts',
      options: { embeddedLanguageFormatting: 'off' },
    },
  ],
};

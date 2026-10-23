import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { loadStandardsData } from '@widedoor/core';
import { REPORT_STYLE, loadPlainData } from '@widedoor/report';
import { thirdPartyNotice } from './licenses.ts';
import type { BundledData } from './src/data.ts';

/*
 * The static viewer that widedoor ui serves. Reference data and the HTML
 * report's style sheet come from the built packages (run tsc -b first) as
 * virtual modules, so the viewer and the HTML report share one source.
 * The output is plain files: one script and one style sheet, no inline code,
 * so the server's CSP (script-src 'self'; style-src 'self') holds.
 */

const DATA = 'virtual:widedoor-data';
const STYLE = 'virtual:widedoor-report.css';

function widedoorData(): Plugin {
  return {
    name: 'widedoor-data',
    resolveId(id) {
      if (id === DATA) return `\0${DATA}`;
      if (id === STYLE) return STYLE;
      return undefined;
    },
    load(id) {
      if (id === STYLE) return REPORT_STYLE;
      if (id !== `\0${DATA}`) return undefined;
      const standards = loadStandardsData();
      const plain = loadPlainData();
      const bundled: BundledData = {
        plain: {
          'axe-core': Object.fromEntries(plain['axe-core']),
          verapdf: Object.fromEntries(plain.verapdf),
          widedoor: Object.fromEntries(plain.widedoor),
        },
        wcag: standards.wcag.criteria.map((c) => [c.id, c.title]),
        provisions: standards.section508.provisions.map((p) => [p.id, p.title]),
      };
      return `export default ${JSON.stringify(bundled)};`;
    },
  };
}

/** THIRD-PARTY-LICENSES.txt, from the modules with code in the bundle (see licenses.ts). */
function thirdPartyLicenses(): Plugin {
  return {
    name: 'widedoor-licenses',
    generateBundle(_, bundle) {
      const rendered = Object.values(bundle).flatMap((out) =>
        out.type === 'chunk'
          ? Object.entries(out.modules)
              .filter(([, m]) => m.renderedLength > 0)
              .map(([id]) => id)
          : [],
      );
      this.emitFile({
        type: 'asset',
        fileName: 'THIRD-PARTY-LICENSES.txt',
        source: thirdPartyNotice(rendered),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), widedoorData(), thirdPartyLicenses()],
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    sourcemap: false,
    reportCompressedSize: false,
  },
});

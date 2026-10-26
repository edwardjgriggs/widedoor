import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, join } from 'node:path';

/*
 * The built viewer (@widedoor/ui's dist/), read into memory at start from
 * one folder: regular files of known types only, so no request path can
 * reach the disk.
 */

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export interface StaticFile {
  body: Uint8Array<ArrayBuffer>;
  type: string;
}

/** The viewer build is missing or unusable. */
export class UiBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UiBuildError';
  }
}

/**
 * Environment variable naming another built viewer folder (absolute path).
 * For tests, which build the viewer to a temp folder so they never overwrite
 * the shipped packages/ui/dist.
 */
export const UI_DIST_ENV = 'WIDEDOOR_UI_DIST';

/** The built viewer: dist/ of the @widedoor/ui package, wherever Node resolves it. */
export function uiDistDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[UI_DIST_ENV];
  if (override) {
    if (!isAbsolute(override)) throw new UiBuildError(`${UI_DIST_ENV} must be an absolute path`);
    return override;
  }
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('@widedoor/ui/package.json')), 'dist');
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_DEPTH = 4;

/**
 * Reads the built viewer into memory, keyed by URL path. Only plain names,
 * known file types and regular files count: symbolic links, junctions and
 * anything else are skipped, so the set of servable paths is fixed at start.
 */
export function loadStaticFiles(dir: string): Map<string, StaticFile> {
  let root: string;
  try {
    root = realpathSync(dir);
  } catch {
    throw new UiBuildError(`the viewer is not built (no ${dir}); run "npm run build"`);
  }
  const files = new Map<string, StaticFile>();
  const walk = (abs: string, prefix: string, depth: number) => {
    for (const name of readdirSync(abs)) {
      if (!SAFE_NAME.test(name)) continue;
      const path = join(abs, name);
      const stat = lstatSync(path);
      if (stat.isDirectory() && depth < MAX_DEPTH) walk(path, `${prefix}${name}/`, depth + 1);
      else if (stat.isFile()) {
        const type = TYPES[extname(name).toLowerCase()];
        if (type)
          files.set(`/${prefix}${name}`, { body: new Uint8Array(readFileSync(path)), type });
      }
    }
  };
  walk(root, '', 0);
  if (!files.has('/index.html'))
    throw new UiBuildError(
      `the viewer is not built (no index.html in ${dir}); run "npm run build"`,
    );
  return files;
}

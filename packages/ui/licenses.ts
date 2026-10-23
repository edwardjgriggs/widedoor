import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Third-party license notices for the viewer bundle, derived from the modules
 * the bundler actually rendered: every npm package with code in the bundle
 * gets its name, version, license and license text. A bundled package with no
 * license field or no license file fails the build. Workspace packages
 * (resolved to packages/, not node_modules/) are Widedoor's own code.
 */

export interface BundledPackage {
  name: string;
  version: string;
  license: string;
  dir: string;
}

const NODE_MODULES = '/node_modules/';
const LICENSE_FILE = /^licen[cs]e(\.(md|txt))?$/i;

/** The npm packages that the given module ids (file paths) belong to, sorted by name. */
export function bundledPackages(moduleIds: Iterable<string>): BundledPackage[] {
  const found = new Map<string, BundledPackage>();
  for (const id of moduleIds) {
    if (id.startsWith('\0')) continue;
    const path = (id.split('?')[0] ?? '').replace(/\\/g, '/');
    const at = path.lastIndexOf(NODE_MODULES);
    if (at < 0) continue;
    const [scope = '', bare = ''] = path.slice(at + NODE_MODULES.length).split('/');
    const name = scope.startsWith('@') ? `${scope}/${bare}` : scope;
    const dir = `${path.slice(0, at)}${NODE_MODULES}${name}`;
    if (found.has(dir)) continue;
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name?: string;
      version?: string;
      license?: string;
    };
    found.set(dir, {
      name: manifest.name ?? name,
      version: manifest.version ?? '',
      license: manifest.license ?? '',
      dir,
    });
  }
  return [...found.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The license text a package ships. Throws when it ships none. */
export function licenseText(dir: string): string {
  const file = readdirSync(dir).find((f) => LICENSE_FILE.test(f));
  if (file === undefined) throw new Error(`${dir} has no license file`);
  return readFileSync(join(dir, file), 'utf8').trim();
}

/** THIRD-PARTY-LICENSES.txt for the given rendered module ids. */
export function thirdPartyNotice(moduleIds: Iterable<string>): string {
  return bundledPackages(moduleIds)
    .map((p) => {
      if (!p.license) throw new Error(`${p.name} has no license field`);
      return `${p.name} ${p.version} (${p.license})\n\n${licenseText(p.dir)}\n`;
    })
    .join('\n');
}

/** The package headings of a THIRD-PARTY-LICENSES.txt, as "name version". */
export const noticePackages = (notice: string): string[] =>
  [...notice.matchAll(/^(\S+) (\S+) \([^)]+\)$/gm)].map((m) => `${m[1]} ${m[2]}`);

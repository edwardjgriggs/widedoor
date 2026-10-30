import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix } from 'node:path';
import MarkdownIt from 'markdown-it';
import { NOT_FOUND_BODY, REPO_URL, page, type NavItem } from './template.ts';

/*
 * The docs site (Task 3b.11, plan ruling 9): README.md split at its ##
 * headings, plus docs/*.md without the operator runbooks, as static HTML
 * with no script. Markdown renders with raw HTML, linkify and typographic
 * replacements off (ruling 10), so nothing in a doc reaches the page
 * unescaped and no dash is introduced. Links between docs become the site's
 * paths; a link to a repository file the site does not build points to it on
 * GitHub; a link to nothing fails the build. Same input, same bytes.
 */

export { REPO_URL };

/** Operator runbooks: for whoever deploys, not for the public site. */
export const RUNBOOKS: readonly string[] = ['hosted-runbook.md', 'docs-site-deploy.md'];

/** One page of the site: its path segment ('' for the home page), its title and its Markdown. */
export interface SourcePage {
  slug: string;
  title: string;
  markdown: string;
  /** The repository file it comes from, with forward slashes. */
  file: string;
  /** How many levels its headings move up (a README section's ## becomes the page h1). */
  shift: number;
}

/** A link that leads nowhere the site or the repository has; the build stops on it. */
export class BrokenLinkError extends Error {}

const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
/** markdown-it's own token type (it ships its types). */
type Token = ReturnType<typeof md.parse>[number];

/** A heading's anchor, as GitHub writes it: lower case, punctuation dropped, spaces as hyphens. */
export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');

/**
 * Splits Markdown at its ## headings, outside code blocks: the part before the first, then
 * each section. As CommonMark: a fence closes only on the same character, at least as many
 * times, with nothing after it but spaces, so a ``` line inside a ```` block stays code.
 */
export function splitAtH2(markdown: string): { heading?: string; markdown: string }[] {
  const parts: { heading?: string; lines: string[] }[] = [{ lines: [] }];
  let open: { char: string; length: number } | undefined;
  for (const line of markdown.split('\n')) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const run = fence[1] as string;
      const rest = fence[2] as string;
      if (!open) {
        // A backtick fence's info string may hold no backtick.
        if (!(run[0] === '`' && rest.includes('`')))
          open = { char: run[0] as string, length: run.length };
      } else if (run[0] === open.char && run.length >= open.length && rest.trim() === '')
        open = undefined;
      parts.at(-1)?.lines.push(line);
      continue;
    }
    const h2 = open ? null : /^## (.+?)\s*#*\s*$/.exec(line);
    if (h2) parts.push({ heading: h2[1] as string, lines: [line] });
    else parts.at(-1)?.lines.push(line);
  }
  return parts.map((p) => ({
    ...(p.heading !== undefined ? { heading: p.heading } : {}),
    markdown: `${p.lines.join('\n').trim()}\n`,
  }));
}

/** The text of an inline token, as a reader sees it. */
const plainText = (inline: Token | undefined): string =>
  (inline?.children ?? [])
    .map((c) => (c.type === 'text' || c.type === 'code_inline' ? c.content : ''))
    .join('')
    .trim();

/** The first # heading of a doc, outside code blocks. */
function firstH1(markdown: string, file: string): string {
  const tokens = md.parse(markdown, {});
  const i = tokens.findIndex((t) => t.type === 'heading_open' && t.tag === 'h1');
  if (i === -1) throw new Error(`${file} has no # heading to title its page`);
  return plainText(tokens[i + 1]);
}

/** The pages of a repository: README.md's parts, then docs/*.md (runbooks left out), by name. */
export function sourcePages(files: ReadonlyMap<string, string>): SourcePage[] {
  const readme = files.get('README.md');
  if (readme === undefined) throw new Error('README.md is missing');
  const [home, ...sections] = splitAtH2(readme);
  const pages: SourcePage[] = [
    {
      slug: '',
      title: firstH1(home!.markdown, 'README.md'),
      markdown: home!.markdown,
      file: 'README.md',
      shift: 0,
    },
    ...sections.map((s) => {
      const title = plainText(md.parseInline(s.heading ?? '', {})[0]);
      return { slug: slugify(title), title, markdown: s.markdown, file: 'README.md', shift: 1 };
    }),
  ];
  const docs = [...files.keys()]
    .filter((f) => /^docs\/[^/]+\.md$/.test(f) && !RUNBOOKS.includes(posix.basename(f)))
    .sort();
  for (const file of docs) {
    const markdown = files.get(file) as string;
    pages.push({
      slug: posix.basename(file, '.md'),
      title: firstH1(markdown, file),
      markdown,
      file,
      shift: 0,
    });
  }
  const seen = new Set<string>();
  for (const p of pages) {
    if (seen.has(p.slug)) throw new Error(`two pages would be at /${p.slug}/`);
    seen.add(p.slug);
  }
  return pages;
}

/**
 * Each heading of a page with its new level and its id, in order: the first is the one h1.
 * `used` counts ids over the whole source file, as GitHub does: a second "Example" anywhere
 * in the README is example-1, whichever section it is in.
 */
function headings(source: SourcePage, tokens: Token[], used: Map<string, number>) {
  const out: { index: number; level: number; id: string; text: string }[] = [];
  tokens.forEach((t, index) => {
    if (t.type !== 'heading_open') return;
    const text = plainText(tokens[index + 1]);
    const base = slugify(text) || 'section';
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    const raw = Number(t.tag.slice(1)) - source.shift;
    const level = out.length === 0 ? 1 : Math.min(6, Math.max(2, raw));
    out.push({ index, level, id: n === 0 ? base : `${base}-${n}`, text });
  });
  return out;
}

/** Where a page's path is: '/' for the home page. */
export const pagePath = (slug: string): string => (slug === '' ? '/' : `/${slug}/`);

interface Target {
  slug: string;
  /** The heading id, or undefined for the page itself. */
  id: string | undefined;
}

/** What a repository path is, for links to what the site does not build. */
export type PathKind = 'file' | 'dir' | undefined;

/**
 * Renders every page to its HTML file. Throws BrokenLinkError for a link to
 * no page, heading or repository path; `kind` says whether a repository path
 * is a file or a folder (a link to either goes to GitHub, blob/ or tree/).
 */
export function renderSite(
  files: ReadonlyMap<string, string>,
  kind: (path: string) => PathKind,
  css: string,
): Map<string, string> {
  const pages = sourcePages(files);
  const idsByFile = new Map<string, Map<string, number>>();
  const parsed = pages.map((p) => {
    const tokens = md.parse(p.markdown, {});
    const used = idsByFile.get(p.file) ?? new Map<string, number>();
    idsByFile.set(p.file, used);
    return { page: p, tokens, headings: headings(p, tokens, used) };
  });
  // Every heading anchor a link can name: README anchors over all its parts, and each doc's own.
  const anchors = new Map<string, Map<string, Target>>();
  for (const { page: p, headings: hs } of parsed) {
    const map = anchors.get(p.file) ?? new Map<string, Target>();
    anchors.set(p.file, map);
    hs.forEach((h, i) => {
      if (!map.has(h.id))
        // A page's h1 is the page itself.
        map.set(h.id, { slug: p.slug, id: i === 0 ? undefined : h.id });
    });
  }
  const bySource = new Map(
    pages.filter((p) => p.file !== 'README.md').map((p) => [p.file, p.slug]),
  );

  const resolve = (href: string, from: SourcePage): { href: string; external: boolean } => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return { href, external: /^https?:/i.test(href) };
    const hash = href.indexOf('#');
    const path = hash === -1 ? href : href.slice(0, hash);
    const fragment = hash === -1 ? undefined : href.slice(hash + 1);
    const file =
      path === '' ? from.file : posix.normalize(posix.join(posix.dirname(from.file), path));
    const local = (target: Target) => {
      if (target.slug === from.slug && target.id !== undefined) return `#${target.id}`;
      return `${pagePath(target.slug)}${target.id !== undefined ? `#${target.id}` : ''}`;
    };
    if (file === 'README.md' || bySource.has(file)) {
      if (fragment === undefined || fragment === '')
        return {
          href: pagePath(file === 'README.md' ? '' : (bySource.get(file) as string)),
          external: false,
        };
      const target = anchors.get(file)?.get(fragment);
      if (!target)
        throw new BrokenLinkError(
          `${from.file} links to #${fragment} in ${file}, which has no such heading`,
        );
      return { href: local(target), external: false };
    }
    const repoPath = file.replace(/\/$/, '');
    const found =
      file.startsWith('../') || file.startsWith('/') || repoPath === '.'
        ? undefined
        : kind(repoPath);
    if (found === undefined)
      throw new BrokenLinkError(
        `${from.file} links to ${href}, which is not a file or folder in the repository`,
      );
    // GitHub shows a file under blob/ and a folder under tree/.
    const view = found === 'dir' ? 'tree' : 'blob';
    return {
      href: `${REPO_URL}/${view}/main/${repoPath}${fragment !== undefined ? `#${fragment}` : ''}`,
      external: true,
    };
  };

  const out = new Map<string, string>();
  const nav: NavItem[] = pages.map((p) => ({
    href: pagePath(p.slug),
    label: p.title,
    slug: p.slug,
  }));
  for (const { page: p, tokens, headings: hs } of parsed) {
    for (const h of hs) {
      const open = tokens[h.index] as Token;
      open.tag = `h${h.level}`;
      open.attrSet('id', h.id);
      (tokens[h.index + 2] as Token).tag = `h${h.level}`;
    }
    const walk = (list: Token[]) => {
      for (const t of list) {
        if (t.children) walk(t.children);
        if (t.type === 'link_open') {
          const target = resolve(String(t.attrGet('href') ?? ''), p);
          t.attrSet('href', target.href);
          if (target.external) t.attrSet('rel', 'noopener noreferrer');
        } else if (t.type === 'image') {
          throw new BrokenLinkError(`${p.file} has an image; the site has none (img-src 'self')`);
        } else if ((t.type === 'th_open' || t.type === 'td_open') && t.attrGet('style')) {
          // The CSP has no 'unsafe-inline' for styles: alignment is a class.
          const align = /text-align:(left|center|right)/.exec(
            String(t.attrGet('style') ?? ''),
          )?.[1];
          t.attrs = (t.attrs ?? []).filter(([name]) => name !== 'style');
          if (align) t.attrSet('class', `align-${align}`);
        }
      }
    };
    walk(tokens);
    const body = md.renderer.render(tokens, md.options, {});
    const file = p.slug === '' ? 'index.html' : `${p.slug}/index.html`;
    out.set(file, page({ title: p.title, current: p.slug, nav, body }));
  }
  out.set(
    '404.html',
    page({ title: 'Page not found', current: undefined, nav, body: NOT_FOUND_BODY }),
  );
  out.set('site.css', css);
  return out;
}

/** README.md and docs/*.md of a repository, by repository path. */
export function readSources(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const read = (path: string) => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');
  files.set('README.md', read('README.md'));
  if (existsSync(join(root, 'docs')))
    for (const name of readdirSync(join(root, 'docs')).sort())
      if (name.endsWith('.md')) files.set(`docs/${name}`, read(`docs/${name}`));
  return files;
}

export const SITE_CSS = new URL('./site.css', import.meta.url);

/** Whether a path is a file, a folder or nothing. */
const pathKind = (path: string): PathKind => {
  try {
    const stat = statSync(path);
    return stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : undefined;
  } catch {
    return undefined;
  }
};

/** Builds the site of the repository at root into out (emptied first). Returns the files written, sorted. */
export function buildSite(root: string, out: string): string[] {
  const css = readFileSync(SITE_CSS, 'utf8').replace(/\r\n/g, '\n');
  const site = renderSite(readSources(root), (path) => pathKind(join(root, path)), css);
  rmSync(out, { recursive: true, force: true });
  const names = [...site.keys()].sort();
  for (const name of names) {
    const path = join(out, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, site.get(name) as string);
  }
  return names;
}

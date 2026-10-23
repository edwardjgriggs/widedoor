/*
 * Help links built from mapping data only (never from scanned content): the
 * Deque page for an axe-core rule and the W3C Understanding page for a WCAG
 * success criterion.
 */

/** Understanding page slug: the SC title in lower case, words joined by hyphens. */
export const understandingSlug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export const understandingUrl = (title: string) =>
  `https://www.w3.org/WAI/WCAG21/Understanding/${understandingSlug(title)}.html`;

export function axeRuleUrl(ruleId: string, engineVersion: string): string {
  const [major = '4', minor = '0'] = engineVersion.split('.');
  return `https://dequeuniversity.com/rules/axe/${major}.${minor}/${encodeURIComponent(ruleId)}`;
}

import type { ReactNode } from 'react';

/*
 * Links to the hosted site's own fixed paths: a finished scan's two report
 * downloads, the about page and the license notice. Nothing from a report or
 * a server answer becomes a link: anything else renders as text.
 */

const SITE_PATH =
  /^\/(?:api\/scans\/[0-9a-f]{32}\/report\.(?:json|html)|about-scanner|THIRD-PARTY-LICENSES\.txt)$/;

export const isSitePath = (href: string): boolean => SITE_PATH.test(href);

export function SiteLink({ href, children }: { href: string; children: ReactNode }) {
  // eslint-disable-next-line no-restricted-syntax -- the hosted page's one checked link renderer
  return isSitePath(href) ? <a href={href}>{children}</a> : <>{children}</>;
}

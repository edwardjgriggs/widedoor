import { describe, expect, it } from 'vitest';
import { readLinks } from '../src/index.ts';

/*
 * readLinks with a stand-in page (offline): the links a page yields, and the
 * unread flag a crawl turns into a scope gap when the page breaks the read.
 */

type EvaluatePage = Parameters<typeof readLinks>[0];

const pageReturning = (value: unknown): EvaluatePage =>
  ({ evaluate: async () => value }) as unknown as EvaluatePage;

describe('readLinks', () => {
  it('normalizes the links, keeps only page URLs and counts what it read', async () => {
    const r = await readLinks(
      pageReturning({
        hrefs: ['https://site.example/a#top', 'mailto:x@site.example', 'https://site.example/a'],
        total: 5,
      }),
    );
    expect(r).toEqual({ links: ['https://site.example/a'], total: 5, read: 3, unread: false });
  });

  it('flags a page whose link read fails, with no links', async () => {
    const broken = {
      evaluate: async () => {
        throw new Error('Execution context was destroyed');
      },
    } as unknown as EvaluatePage;
    expect(await readLinks(broken)).toEqual({ links: [], total: 0, read: 0, unread: true });
  });
});

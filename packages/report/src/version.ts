import { readFileSync } from 'node:fs';

/** Version of Widedoor itself: the @widedoor/report package version. */
export const WIDEDOOR_VERSION: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

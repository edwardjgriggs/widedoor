/*
 * The part of @widedoor/report that runs in a browser: the report model and
 * its parser, the summary, override, diff and view helpers, plain-language lookup, help links
 * and the visible-text escape. No Node built-ins; the file loaders, the
 * screenshot loader and the reporters stay in the main entry.
 */
export * from './model.js';
export * from './json.js';
export * from './summary.js';
export * from './overrides.js';
export * from './diff.js';
export * from './view.js';
export * from './plain-data.js';
export * from './links.js';
export * from './viewer.js';
export { visibleText } from './escape.js';

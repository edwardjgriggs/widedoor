/** Where the W3C publishes the ACT rules test cases; corpus/act mirrors the tree below it. */
export const ACT_BASE = 'https://www.w3.org/WAI/content-assets/wcag-act-rules/';
export const ACT_INDEX = `${ACT_BASE}testcases.json`;
export const ACT_LICENSE = 'https://act-rules.github.io/pages/license/';

/** The repository the W3C site publishes ACT_BASE from, pinned for reproducible vendoring. */
export const ACT_COMMIT = 'b079e8691d5ed968df5cfe8e2f53092d967b220d';
export const ACT_MIRROR = `https://raw.githubusercontent.com/w3c/wcag-act-rules/${ACT_COMMIT}/content-assets/wcag-act-rules/`;

export type ActOutcome = 'passed' | 'failed' | 'inapplicable';

export const ACT_TO_OUTCOME = {
  passed: 'pass',
  failed: 'fail',
  inapplicable: 'not-applicable',
} as const;

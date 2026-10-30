import type { ProfileId } from '@widedoor/core/browser';

/*
 * The profile choices, shared by the local Scan screen and the hosted page
 * (which must not import a local screen). '' leaves the profile to
 * widedoor.config.yaml (and its default); the hosted page has no config file
 * and leaves it out.
 */

export const PROFILES: readonly { id: ProfileId | ''; label: string }[] = [
  { id: '', label: 'As in widedoor.config.yaml' },
  { id: '508+wcag21aa', label: 'Section 508 and WCAG 2.1 AA (508+wcag21aa)' },
  { id: '508', label: 'Section 508 (508)' },
  { id: 'wcag21aa', label: 'WCAG 2.1 AA (wcag21aa)' },
];

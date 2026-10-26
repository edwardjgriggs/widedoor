export const PROFILE_IDS = ['508', 'wcag21aa', '508+wcag21aa'] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];
/** The standard views a roll-up can hold. */
export const STANDARD_IDS = ['508', 'wcag21aa'] as const;
export type StandardId = (typeof STANDARD_IDS)[number];
/** Whether a PDF counts as a non-web document (E205.4 exceptions apply) or as web content. */
export type PdfDocumentType = 'non-web' | 'web';
